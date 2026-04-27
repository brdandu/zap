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

/**
 * This file contains watchdogs.
 *
 * @module watchdog API: initializes times.
 */

/**
 * Creates an independent watchdog instance.
 *
 * A watchdog is a refreshable timer: if `reset()` is not called within
 * `expirationInterval` ms, `triggerFunction` fires once. Call `stop()` to
 * cancel it entirely. Multiple watchdogs can coexist (e.g. one per
 * template render and one for overall server inactivity).
 *
 * @param {number} expirationInterval - ms of inactivity before triggering.
 * @param {Function} triggerFunction - invoked when the watchdog expires.
 * @returns {{ reset: Function, stop: Function }}
 */
function createWatchdog(expirationInterval, triggerFunction) {
  let id = setTimeout(triggerFunction, expirationInterval)
  // Do not keep the event loop alive just because of this timer.
  if (typeof id.unref === 'function') id.unref()
  let stopped = false
  return {
    reset() {
      if (stopped) return
      if (id != null && typeof id.refresh === 'function') id.refresh()
    },
    stop() {
      stopped = true
      if (id != null) {
        clearTimeout(id)
        id = null
      }
    }
  }
}

exports.createWatchdog = createWatchdog
