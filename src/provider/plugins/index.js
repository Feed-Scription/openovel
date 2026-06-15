import { anthropicProvider } from "./anthropic.js"
import { customAnthropicProvider } from "./customAnthropic.js"
import { customOpenAIProvider } from "./customOpenai.js"
import { deepseekProvider } from "./deepseek.js"
import { kimiCodeProvider } from "./kimiCode.js"
import { mimoApiProvider, mimoTokenPlanProviders } from "./mimo.js"
import { openrouterProvider } from "./openrouter.js"

export const builtinProviders = [
  kimiCodeProvider,
  ...mimoTokenPlanProviders,
  mimoApiProvider,
  deepseekProvider,
  openrouterProvider,
  anthropicProvider,
  customAnthropicProvider,
  customOpenAIProvider,
]
