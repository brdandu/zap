/**
 *
 *    Copyright (c) 2020 Silicon Labs
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

// enable stack trace to be mapped back to the correct line number in TypeScript source files.
require('source-map-support').install()

const args = require('../util/args')
const env = require('../util/env')
const util = require('../util/util')
const startup = require('./startup')

// For `validate` without an output file, the JSON report is printed to stdout.
// Route any incidental console.log noise (version checks, state dir, etc.)
// to stderr so stdout remains a clean JSON document.
{
  let rawArgs = process.argv.slice(2)
  let isValidateToStdout =
    rawArgs.includes('validate') &&
    !rawArgs.some(
      (a) =>
        a === '-o' ||
        a === '--output' ||
        a === '--validateOutput' ||
        a.startsWith('-o=') ||
        a.startsWith('--output=') ||
        a.startsWith('--validateOutput=')
    )
  if (isValidateToStdout) {
    console.log = (...a) => console.error(...a)
  }
}

env.versionsCheck()
env.setProductionEnv()

let argv = args.processCommandLineArguments(process.argv)
util.mainOrSecondaryInstance(
  argv.reuseZapInstance,
  () => {
    startup.startUpMainInstance(argv, {
      quitFunction: () => process.exit(0),
      uiEnableFunction: null
    })
  },
  () => {
    startup.startUpSecondaryInstance(argv, { quitFunction: null })
  }
)

// If the code is executed via 'node' and not via 'electron', then this
// is where we end up.

exports.loaded = true
