import { EmailMessage } from "cloudflare:email";

export interface Env {
  telegramBotToken: string;
  telegramChatId: string;
  sendEmail?: string;
  emailFrom?: string;
  destinationAddress?: string;
  emailSender: {
    send(message: EmailMessage): Promise<void>;
  };
}

interface InboundEmailMessage {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer;
  setReject(reason: string): void;
}

function clip(text: string, max = 3500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function splitHeadersAndBody(raw: string): { headers: string; body: string } {
  const match = raw.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) {
    return { headers: raw, body: "" };
  }

  const splitAt = match.index;
  const sepLength = match[0].length;
  return {
    headers: raw.slice(0, splitAt),
    body: raw.slice(splitAt + sepLength),
  };
}

function parseHeaders(rawHeaders: string): Record<string, string> {
  const lines = rawHeaders.split(/\r?\n/);
  const unfolded: string[] = [];

  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }

  const headers: Record<string, string> = {};
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    headers[key] = val;
  }
  return headers;
}

function parseBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  return (match[1] || match[2] || "").trim();
}

function parseCharset(contentType: string): string {
  const match = contentType.match(/charset=(?:"([^"]+)"|([^;]+))/i);
  const parsed = (match?.[1] || match?.[2] || "").trim();
  return parsed || "utf-8";
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQuotedPrintable(input: string, charset: string): string {
  const cleaned = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === "=" && /^[A-Fa-f0-9]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(cleaned.charCodeAt(i) & 0xff);
  }

  return decodeBytes(new Uint8Array(bytes), charset);
}

function decodeBase64(input: string, charset: string): string {
  try {
    const cleaned = input.replace(/\s/g, "");
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }

    return decodeBytes(bytes, charset);
  } catch {
    return input;
  }
}

function decodeTransferEncoding(body: string, encoding: string, contentType: string): string {
  const charset = parseCharset(contentType);
  const normalized = encoding.toLowerCase();
  if (normalized.includes("quoted-printable")) return decodeQuotedPrintable(body, charset);
  if (normalized.includes("base64")) return decodeBase64(body, charset);
  return body;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitMultipartBody(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const endMarker = `--${boundary}--`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] = [];
  let inPart = false;

  for (const line of lines) {
    if (line === marker) {
      if (inPart && current.length > 0) {
        parts.push(current.join("\n").trim());
        current = [];
      }
      inPart = true;
      continue;
    }
    if (line === endMarker) {
      if (inPart && current.length > 0) {
        parts.push(current.join("\n").trim());
      }
      break;
    }
    if (inPart) current.push(line);
  }

  return parts.filter(Boolean);
}

function isAttachment(headers: Record<string, string>): boolean {
  const disposition = (headers["content-disposition"] || "").toLowerCase();
  return disposition.includes("attachment") || disposition.includes("filename=");
}

function isPlainText(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/plain");
}

function isHtmlText(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html");
}

function extractBestBodyFromMime(raw: string): string {
  const { headers: rawHeaders, body } = splitHeadersAndBody(raw);
  const headers = parseHeaders(rawHeaders);
  const contentType = headers["content-type"]?.toLowerCase() || "text/plain";
  const encoding = headers["content-transfer-encoding"] || "";

  if (contentType.includes("multipart/")) {
    const boundary = parseBoundary(headers["content-type"] || "");
    if (!boundary) return body.trim();

    const parts = splitMultipartBody(body, boundary);
    let htmlFallback = "";

    for (const part of parts) {
      const { headers: partRawHeaders, body: partBody } = splitHeadersAndBody(part);
      const partHeaders = parseHeaders(partRawHeaders);
      const partType = partHeaders["content-type"]?.toLowerCase() || "";

      if (isAttachment(partHeaders)) continue;

      if (partType.includes("multipart/")) {
        const nestedText = extractBestBodyFromMime(part);
        if (nestedText.trim()) return nestedText.trim();
        continue;
      }

      const partEncoding = partHeaders["content-transfer-encoding"] || "";
      const decodedPart = decodeTransferEncoding(partBody, partEncoding, partHeaders["content-type"] || "");

      if (isPlainText(partType)) {
        const text = decodedPart.trim();
        if (text) return text;
      }

      if (isHtmlText(partType) && !htmlFallback) {
        const htmlText = stripHtml(decodedPart).trim();
        if (htmlText) htmlFallback = htmlText;
      }
    }

    return htmlFallback || body.trim();
  }

  const decoded = decodeTransferEncoding(body, encoding, headers["content-type"] || "");
  if (contentType.includes("text/html")) return stripHtml(decoded);
  return decoded.trim();
}

function buildMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1]?.trim() || "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

function formatNzTimestamp(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

export default {
  async fetch(): Promise<Response> {
    return new Response("📩 - Cloudlare Email Worker - Telegram & Email Forwarder\nStatus - Working ... 🟩", { status: 200 });
  },

  async email(message: InboundEmailMessage, env: Env): Promise<void> {
    if (!env.telegramBotToken || !env.telegramChatId) {
      console.error("Missing telegramBotToken or telegramChatId");
      message.setReject("Misconfigured");
      return;
    }

    const raw = await new Response(message.raw).text();
    const extractedBody = extractBestBodyFromMime(raw) || "[empty message body]";

    const telegramText = [
      "📩 - Cloudflare Email Worker ...",
      "",
      `To - ${message.to}`,
      "",
      "Message -",
      clip(extractedBody),
      "",
      "Received -",
      formatNzTimestamp(),
    ].join("\n");

    const response = await fetch(
      `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: env.telegramChatId,
          text: telegramText,
          disable_web_page_preview: true,
        }),
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error("Telegram sending failed ...", response.status, errText);
      message.setReject("Failed to forward email");
      return;
    }

    const shouldSendEmail =
      typeof env.sendEmail === "string" &&
      ["1", "true", "yes", "on"].includes(env.sendEmail.trim().toLowerCase());

    if (shouldSendEmail) {

      const subject = `Cloudflare Email Worker - ${message.to}`;
      const messageId = buildMessageId(message.from);
      const date = new Date().toUTCString();
      const emailBody = [
        "📩 - Cloudflare Email Worker ...",
        "",
        `To - ${message.to}`,
        "",
        "Message -",
        extractedBody,
        "",
        "Received -",
        formatNzTimestamp()
      ].join("\n");

      const rawEmail = [
        `From: ${message.to}`,
        `To: ${env.destinationAddress}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        emailBody,
      ].join("\r\n");

      try {
        const outbound = new EmailMessage(message.to, env.destinationAddress, rawEmail);
        await env.emailSender.send(outbound);
      } catch (error) {
        console.error("Email sending failed ...", error);
        message.setReject("Failed to send email");
        return;
      }
    }

    console.log(`Forwarded email from ${message.to.trim()} to Telegram - ${env.telegramChatId}`);
  },
};
