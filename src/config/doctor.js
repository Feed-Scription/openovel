import { diagnoseSettings } from "./settings.js"
import { workspaceLayout } from "../lib/workspacePaths.js"

const diagnosis = diagnoseSettings()
const workspace = workspaceLayout()

console.log("openovel config doctor")
console.log("")
console.log("sources:")
if (diagnosis.sources.length) {
  for (const source of diagnosis.sources) {
    console.log(`  - ${source.kind} ${source.path || source.source}`)
  }
} else {
  console.log("  - defaults only")
}
console.log("")
console.log("errors:")
if (diagnosis.errors.length) {
  for (const error of diagnosis.errors) {
    console.log(`  - ${error.path || error.source}: ${error.message}`)
  }
} else {
  console.log("  - none")
}
console.log("")
console.log("workspace:")
console.log(`  home: ${workspace.home}`)
console.log(`  storyRoot: ${workspace.storyRoot}`)
console.log(`  userMemory: ${workspace.userMemory}`)
console.log(`  sharedReferences: ${workspace.sharedReferences}`)
console.log("")
console.log("effective:")
console.log(JSON.stringify(diagnosis.settings, null, 2))
