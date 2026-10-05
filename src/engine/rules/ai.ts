import type { Rule } from "../../types";

export const aiRules: Rule[] = [
  { id: "openai-api-key", severity: "block", description: "OpenAI API key", pattern: "\\bsk-(?!ant-|admin)[A-Za-z0-9_-]{20,}\\b" },
  { id: "anthropic-key", severity: "block", description: "Anthropic API key", pattern: "\\bsk-ant-[A-Za-z0-9-]{16,}\\b" },
  { id: "openrouter-key", severity: "block", description: "OpenRouter API key", pattern: "\\bsk-or-v1-[a-f0-9]{48,64}\\b" },
  { id: "hf-token", severity: "block", description: "HuggingFace token", pattern: "\\bhf_[A-Za-z0-9]{34}\\b" },
  { id: "replicate-token", severity: "block", description: "Replicate API token", pattern: "\\br8_[A-Za-z0-9]{37}\\b" },
  { id: "groq-key", severity: "block", description: "Groq API key", pattern: "\\bgsk_[A-Za-z0-9]{40,52}\\b" },
  { id: "deepseek-key", severity: "block", description: "DeepSeek API key", pattern: "\\bsk-[a-f0-9]{32}\\b" },
];
