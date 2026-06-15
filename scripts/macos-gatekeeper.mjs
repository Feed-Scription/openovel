#!/usr/bin/env node

import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2).filter(Boolean)

function usage() {
  console.log(`usage: node scripts/macos-gatekeeper.mjs <path-to-openovel.app> [more paths...]`)
  console.log(``)
  console.log(`Examples:`)
  console.log(`  npm run mac:unquarantine -- /Applications/openovel.app`)
  console.log(`  npm run mac:unquarantine -- ~/Downloads/openovel.app`)
  console.log(``)
  console.log(`This removes the com.apple.quarantine attribute from local test builds.`)
  console.log(`It does not replace Developer ID signing or notarization.`)
}

function expandHome(input) {
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  return input
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with ${code}`))
    })
  })
}

if (process.platform !== "darwin") {
  console.error("macOS Gatekeeper quarantine attributes only exist on macOS.")
  process.exit(2)
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  usage()
  process.exit(args.length === 0 ? 2 : 0)
}

for (const input of args) {
  const target = path.resolve(expandHome(input))
  await access(target)
  console.log(`clearing quarantine: ${target}`)
  await run("xattr", ["-dr", "com.apple.quarantine", target])
  console.log(`checking signature assessment: ${target}`)
  await run("spctl", ["--assess", "--type", "execute", "--verbose=4", target]).catch((error) => {
    console.warn(`spctl still reports a Gatekeeper issue: ${error.message}`)
    console.warn(`This is expected for unsigned, non-notarized release builds.`)
  })
}
