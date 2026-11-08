// The words of what Helpdesk writes to customers itself: the acknowledgement of a new request, the satisfaction
// question and its page, and the thanks page after a form. English, German and Turkish; the file's support.language
// picks the emails' language, and the reader's browser the pages'.
import type { Language } from "./config.ts";

const EN = {
  ackSubject: "We have your request [#{number}]",
  ackText: "Hello {name},\n\nWe have your request and will answer as soon as we can. Its number is #{number}; reply to this email to add to it.\n\n{support}",
  askSubject: "How did we do? [#{number}]",
  askText: 'Hello {name},\n\nYour request #{number}, "{subject}", is solved. How did we do? Choose one:\n\n{links}\n\nThank you,\n{support}',
  askLead: 'Your request #{number}, "{subject}", is solved. How did we do?',
  score5: "Very good",
  score4: "Good",
  score3: "Okay",
  score2: "Bad",
  score1: "Very bad",
  hello: "Hello {name},",
  thanksSign: "Thank you,",
  pageTitle: "How did we do?",
  pageLead: 'Your request #{number}, "{subject}".',
  pageScore: "Your answer",
  pageComment: "Anything to add? (optional)",
  pageSend: "Send",
  pageThanks: "Thank you. Your answer reaches the team.",
  pageChange: "You can change it here until {date}.",
  pageGone: "This link has ended",
  pageGoneText: "The question about this request is closed. Reply to the last email from support to reach the team.",
  formThanks: "Thank you",
  formThanksText: "We have your request. Its number is #{number}; we answer by email.",
  formFailed: "Your request could not be sent",
};
type Words = typeof EN;

const DE: Words = {
  ackSubject: "Wir haben Ihre Anfrage erhalten [#{number}]",
  ackText:
    "Hallo {name},\n\nwir haben Ihre Anfrage erhalten und antworten so bald wie möglich. Ihre Nummer ist #{number}; antworten Sie auf diese E-Mail, um etwas hinzuzufügen.\n\n{support}",
  askSubject: "Wie zufrieden waren Sie? [#{number}]",
  askText:
    "Hallo {name},\n\nIhre Anfrage #{number}, „{subject}“, ist gelöst. Wie zufrieden waren Sie? Wählen Sie eine Antwort:\n\n{links}\n\nVielen Dank\n{support}",
  askLead: "Ihre Anfrage #{number}, „{subject}“, ist gelöst. Wie zufrieden waren Sie?",
  score5: "Sehr gut",
  score4: "Gut",
  score3: "In Ordnung",
  score2: "Schlecht",
  score1: "Sehr schlecht",
  hello: "Hallo {name},",
  thanksSign: "Vielen Dank",
  pageTitle: "Wie zufrieden waren Sie?",
  pageLead: "Ihre Anfrage #{number}, „{subject}“.",
  pageScore: "Ihre Antwort",
  pageComment: "Möchten Sie etwas hinzufügen? (optional)",
  pageSend: "Senden",
  pageThanks: "Vielen Dank. Ihre Antwort erreicht das Team.",
  pageChange: "Sie können sie hier bis zum {date} ändern.",
  pageGone: "Dieser Link ist abgelaufen",
  pageGoneText: "Die Frage zu dieser Anfrage ist geschlossen. Antworten Sie auf die letzte E-Mail des Supports, um das Team zu erreichen.",
  formThanks: "Vielen Dank",
  formThanksText: "Wir haben Ihre Anfrage erhalten. Ihre Nummer ist #{number}; wir antworten per E-Mail.",
  formFailed: "Ihre Anfrage konnte nicht gesendet werden",
};

const TR: Words = {
  ackSubject: "Talebinizi aldık [#{number}]",
  ackText:
    "Merhaba {name},\n\nTalebinizi aldık, en kısa sürede yanıtlayacağız. Talep numaranız #{number}; eklemek istediğiniz bir şey olursa bu e-postayı yanıtlayın.\n\n{support}",
  askSubject: "Nasıl yardımcı olduk? [#{number}]",
  askText: 'Merhaba {name},\n\n#{number} numaralı "{subject}" talebiniz çözüldü. Nasıl yardımcı olduk? Birini seçin:\n\n{links}\n\nTeşekkürler,\n{support}',
  askLead: '#{number} numaralı "{subject}" talebiniz çözüldü. Nasıl yardımcı olduk?',
  score5: "Çok iyi",
  score4: "İyi",
  score3: "Fena değil",
  score2: "Kötü",
  score1: "Çok kötü",
  hello: "Merhaba {name},",
  thanksSign: "Teşekkürler,",
  pageTitle: "Nasıl yardımcı olduk?",
  pageLead: '#{number} numaralı "{subject}" talebiniz.',
  pageScore: "Yanıtınız",
  pageComment: "Eklemek istediğiniz bir şey var mı? (isteğe bağlı)",
  pageSend: "Gönder",
  pageThanks: "Teşekkürler. Yanıtınız ekibe ulaşır.",
  pageChange: "{date} tarihine kadar buradan değiştirebilirsiniz.",
  pageGone: "Bu bağlantının süresi doldu",
  pageGoneText: "Bu talebe ilişkin soru kapandı. Ekibe ulaşmak için destekten gelen son e-postayı yanıtlayın.",
  formThanks: "Teşekkürler",
  formThanksText: "Talebinizi aldık. Talep numaranız #{number}; e-postayla yanıtlıyoruz.",
  formFailed: "Talebiniz gönderilemedi",
};

const WORDS: Record<Language, Words> = { en: EN, de: DE, tr: TR };

export type WordKey = keyof Words;

export function words(lang: string) {
  const w = WORDS[(lang.slice(0, 2) as Language) in WORDS ? (lang.slice(0, 2) as Language) : "en"];
  return (key: WordKey, vars: Record<string, string | number> = {}) => w[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/** The reader's language from Accept-Language, among English, German and Turkish, or the fallback. */
export function negotiate(header: string | undefined, fallback: Language): Language {
  for (const part of (header ?? "").split(",")) {
    const tag = part.trim().split(";")[0]!.toLowerCase().slice(0, 2);
    if (tag === "en" || tag === "de" || tag === "tr") return tag;
  }
  return fallback;
}

/** "Hello Gizem," or "Hello," when the name is not known. */
export function greeting(lang: string, name: string | null) {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return words(lang)("hello", { name: first }).replace(/\s+,/, ",").replace(/ ,/, ",");
}
