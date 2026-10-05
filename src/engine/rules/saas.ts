import type { Rule } from "../../types";

export const saasRules: Rule[] = [
  { id: "slack-token", severity: "block", description: "Slack token", pattern: "\\bxox[bapr]-[A-Za-z0-9-]{10,}\\b" },
  { id: "stripe-live", severity: "block", description: "Stripe live secret key", pattern: "\\bsk_live_[0-9a-zA-Z]{24,}\\b" },
  { id: "stripe-restricted", severity: "block", description: "Stripe restricted key", pattern: "\\brk_live_[0-9a-zA-Z]{24,}\\b" },
  { id: "twilio-key", severity: "block", description: "Twilio API key", pattern: "\\bSK[0-9a-f]{32}\\b" },
  { id: "sendgrid-key", severity: "block", description: "SendGrid API key", pattern: "\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}\\b" },
  { id: "mailgun-key", severity: "block", description: "Mailgun API key", pattern: "\\bkey-[0-9a-zA-Z]{32}\\b" },
  { id: "mailchimp-key", severity: "block", description: "Mailchimp API key", pattern: "\\b[0-9a-f]{32}-us[0-9]{1,2}\\b" },
  { id: "sentry-dsn", severity: "block", description: "Sentry DSN (secret)", pattern: "https://[0-9a-f]{32}@[a-z0-9.]+/[0-9]+" },
  // Ngữ cảnh: keyword "datadog"/"dd_api_key" cách key hex-32 ≤40 ký tự trên cùng dòng
  { id: "datadog-key", severity: "block", description: "Datadog API key (kèm ngữ cảnh datadog)", pattern: "(?:datadog|dd_api_key)[^\\n]{0,40}?[a-f0-9]{32}" },
  { id: "grafana-key", severity: "block", description: "Grafana service account token", pattern: "\\bglsa_[A-Za-z0-9]{32,}\\b" },
  // Ngữ cảnh: keyword "cloudflare" cách token 40 ký tự ≤40 ký tự trên cùng dòng
  { id: "cloudflare-key", severity: "block", description: "Cloudflare API token (kèm ngữ cảnh cloudflare)", pattern: "cloudflare[^\\n]{0,40}?[A-Za-z0-9_-]{40}" },
  { id: "vercel-token", severity: "block", description: "Vercel token", pattern: "\\bvercel_[A-Za-z0-9]{36}\\b" },
  { id: "supabase-key", severity: "block", description: "Supabase service role JWT", pattern: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\\.eyJpc3MiOiJzdXBhYmFzZ" },
  { id: "shopify-token", severity: "block", description: "Shopify access token", pattern: "\\bshpat_[0-9a-fA-F]{32}\\b" },
  { id: "linear-key", severity: "block", description: "Linear API key", pattern: "\\blin_api_[A-Za-z0-9]{40}\\b" },
  { id: "notion-key", severity: "block", description: "Notion integration token", pattern: "\\bsecret_[A-Za-z0-9]{43}\\b" },
  { id: "telegram-bot", severity: "block", description: "Telegram bot token", pattern: "\\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\\b" },
  { id: "discord-bot", severity: "block", description: "Discord bot token", pattern: "\\b[MNO][A-Za-z0-9_-]{23,}\\.[A-Za-z0-9_-]{6,7}\\.[A-Za-z0-9_-]{27,}\\b" },
];
