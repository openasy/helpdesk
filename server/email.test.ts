import { describe, expect, it } from "vitest";
import { addressTicket, cleanSubject, newMessageId, newPart, ourTickets, parseEmail, replyAddress, replySubject, subjectTicket } from "./email.ts";
import { sanitizeEmail } from "./sanitize.ts";
import { rawEmail } from "./test-app.ts";

describe("reading an email", () => {
  it("takes the sender, recipients, threading headers and text", async () => {
    const m = await parseEmail(
      rawEmail({
        from: '"Gizem Avcı" <Gizem@Avci.example>',
        to: "Support <support@acme.example>, it@acme.example",
        subject: "Re: Invoices fail [#1001]",
        text: "Hello",
        id: "<a1@avci.example>",
        inReplyTo: "<hd.1001.0123456789ab@acme.example>",
        references: "<x@avci.example> <hd.1001.0123456789ab@acme.example>",
        headers: { "Delivered-To": "support+1001-deadbeef@acme.example" },
      }),
    );
    expect(m.from).toEqual({ email: "gizem@avci.example", name: "Gizem Avcı" });
    expect(m.recipients).toEqual(["support@acme.example", "it@acme.example", "support+1001-deadbeef@acme.example"]);
    expect(m.messageId).toBe("<a1@avci.example>");
    expect(m.inReplyTo).toEqual(["<hd.1001.0123456789ab@acme.example>"]);
    expect(m.references).toHaveLength(2);
    expect(m.auto).toBeNull();
    expect(m.bounce).toBeNull();
    expect(ourTickets(m.references)).toEqual([1001]);
  });

  it("knows automatic emails, whatever kind", async () => {
    const auto = async (headers: Record<string, string>, subject = "Re: Your request") =>
      (await parseEmail(rawEmail({ from: "a@b.example", subject, text: "x", headers }))).auto;
    expect(await auto({ "Auto-Submitted": "auto-replied" })).toBe("Auto-Submitted: auto-replied");
    expect(await auto({ "Auto-Submitted": "no" })).toBeNull();
    expect(await auto({ "X-Autoreply": "yes" })).toBe("X-Autoreply");
    expect(await auto({ Precedence: "bulk" })).toBe("Precedence: bulk");
    expect(await auto({ "List-Id": "<news.example.com>" })).toBe("a mailing list (List-Id)");
    expect(await auto({}, "Automatic reply: Your request")).toBe("an automatic subject");
    expect(await auto({}, "Abwesenheitsnotiz: Ihre Anfrage")).toBe("an automatic subject");
    expect(await auto({}, "Otomatik yanıt: Talebiniz")).toBe("an automatic subject");
    // A person writing about auto replies is a person.
    expect(await auto({}, "Automatic reply not working in my account")).toBeNull();
    expect(await auto({}, "Out of office settings: how?")).toBeNull();
    expect(await auto({}, "Out of Office: Re: Your request")).toBe("an automatic subject");
  });

  it("knows a bounce and which of our emails it was", async () => {
    const raw = [
      "From: Mail Delivery System <MAILER-DAEMON@mx.acme.example>",
      "To: support@acme.example",
      "Subject: Undelivered Mail Returned to Sender",
      "Message-ID: <bounce1@mx.acme.example>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="r"',
      "",
      "--r",
      "Content-Type: text/plain",
      "",
      "Your message could not be delivered.",
      "--r",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.acme.example",
      "",
      "Final-Recipient: rfc822; gone@customer.example",
      "Action: failed",
      "Status: 5.1.1",
      "--r",
      "Content-Type: text/rfc822-headers",
      "",
      "Message-ID: <hd.1002.a1b2c3d4e5f6@acme.example>",
      "Subject: Re: Help [#1002]",
      "--r--",
      "",
    ].join("\r\n");
    const m = await parseEmail(raw);
    expect(m.bounce).toEqual({ recipients: ["gone@customer.example"], ours: ["<hd.1002.a1b2c3d4e5f6@acme.example>"] });
    expect(m.auto).toBe("a bounce");
  });

  it("finds the new part of a reply", () => {
    expect(newPart("Thanks, that worked.\n\nOn Mon, 2 Nov 2026 at 14:05, Acme Support <support@acme.example> wrote:\n> Please send again.")).toBe(
      "Thanks, that worked.",
    );
    expect(newPart("Danke!\n\nAm 02.11.2026 um 14:05 schrieb Acme Support <support@acme.example>:\n> Bitte erneut senden.")).toBe("Danke!");
    expect(newPart("Teşekkürler.\n\n2 Kas 2026 Pzt, 14:05 tarihinde Acme Support <support@acme.example> şunu yazdı:\n> Tekrar gönderin.")).toBe("Teşekkürler.");
    expect(newPart("Done.\n\nFrom: Acme Support <support@acme.example>\nSent: Monday\nTo: Gizem\nSubject: Re: Help")).toBe("Done.");
    expect(newPart("Still broken\n\n> earlier text\n> more")).toBe("Still broken");
    expect(newPart("> only a quote")).toBe("> only a quote");
  });
});

describe("threading tokens", () => {
  it("makes Message-IDs on the support address's domain, and reads them back", () => {
    const id = newMessageId(1007, "support@acme.example");
    expect(id).toMatch(/^<hd\.1007\.[0-9a-f]{12}@acme\.example>$/);
    expect(ourTickets([id, "<other@x.example>"])).toEqual([1007]);
  });

  it("puts the number in the subject once", () => {
    expect(replySubject("Invoices fail", 1001, true)).toBe("Re: Invoices fail [#1001]");
    expect(replySubject("Re: Invoices fail [#1001]", 1001, true)).toBe("Re: Invoices fail [#1001]");
    expect(replySubject("AW: Rechnung", 1001, false)).toBe("AW: Rechnung");
    expect(subjectTicket("RE: Re: Invoices fail [#1001]")).toBe(1001);
    expect(cleanSubject("Fwd: RE: Invoices fail [#1001]")).toBe("Invoices fail");
  });

  it("signs the reply address, so a guessed one does not thread", () => {
    const a = replyAddress("support@acme.example", 1001, "secret");
    expect(a).toMatch(/^support\+1001-[0-9a-f]{8}@acme\.example$/);
    expect(addressTicket([a], ["support@acme.example"], "secret")).toBe(1001);
    expect(addressTicket([a.replace("1001", "1002")], ["support@acme.example"], "secret")).toBeNull();
    expect(addressTicket([a], ["other@acme.example"], "secret")).toBeNull();
  });
});

describe("email HTML", () => {
  it("keeps formatting and removes what could run or track", () => {
    const html = sanitizeEmail(
      `<style>p{color:red}</style><p style="background:url(https://t.example/x)" onclick="alert(1)">Hi <b>there</b></p>
<script>alert(1)</script><img src="https://tracker.example/open.gif" alt="logo"><img src="cid:img1@x"><a href="javascript:alert(1)">x</a>
<a href="https://acme.example/help">help</a><iframe src="https://x.example"></iframe><form><input></form>`,
      { "img1@x": "/api/v1/attachments/abc" },
    );
    expect(html).not.toMatch(/script|style|onclick|iframe|form|input|tracker|javascript/);
    expect(html).toContain("<p>Hi <b>there</b></p>");
    expect(html).toContain('<img src="/api/v1/attachments/abc" />');
    expect(html).toContain('<a href="https://acme.example/help" rel="noopener noreferrer nofollow" target="_blank">help</a>');
  });
});
