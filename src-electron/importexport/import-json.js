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
const fs = require('fs')
const util = require('../util/util.js')
const dbEnum = require('../../src-shared/db-enum.js')
const env = require('../util/env')
const queryPackage = require('../db/query-package.js')
const queryImpexp = require('../db/query-impexp.js')
const querySession = require('../db/query-session.js')
const queryZcl = require('../db/query-zcl.js')
const querySessionNotice = require('../db/query-session-notification.js')
const queryDeviceType = require('../db/query-device-type.js')
const zclLoader = require('../zcl/zcl-loader.js')
const generationEngine = require('../generator/generation-engine')

/**
 * Resolves with a promise that imports session key values.
 *
 * @param {*} db
 * @param {*} sessionId
 * @param {*} keyValuePairs
 */
async function importSessionKeyValues(db, sessionId, keyValuePairs) {
  let allQueries = []
  if (keyValuePairs != null) {
    env.logDebug(`Loading ${keyValuePairs.length} key value pairs.`)
    // Write key value pairs
    keyValuePairs.forEach((element) => {
      allQueries.push(
        querySession.updateSessionKeyValue(
          db,
          sessionId,
          element.key,
          element.value
        )
      )
    })
  }
  return Promise.all(allQueries).then(() => sessionId)
}

function getPkgPath(pkg, zapFilePath) {
  if ('pathRelativity' in pkg) {
    return util.createAbsolutePath(pkg.path, pkg.pathRelativity, zapFilePath)
  } else {
    return pkg.path
  }
}

/**
 * Auto-load package. If succesful it returns an object.
 * Otherwise it throws an exception.
 *
 * @param {*} db
 * @param {*} pkg
 * @param {*} absPath
 * @returns object containing packageId and packageType.
 */
async function autoLoadPackage(db, pkg, absPath) {
  if (pkg.type === dbEnum.packageType.zclProperties) {
    let ctx = await zclLoader.loadZcl(db, absPath)
    return {
      packageId: ctx.packageId,
      packageType: pkg.type,
    }
  } else if (pkg.type === dbEnum.packageType.genTemplatesJson) {
    let ctx = await generationEngine.loadTemplates(db, [absPath], {
      failOnLoadingError: true,
    })
    if (ctx.error) throw new Error(ctx.error)
    return {
      packageId: ctx.packageId,
      packageType: pkg.type,
    }
  } else {
    throw new Error(
      `Auto-loading of package type "${pkg.type}" is not implemented.`
    )
  }
}

/**
 * Resolves into a { packageId:, packageType:}
 * object, pkg has`path`, `version`, `type`. It can ALSO have pathRelativity. If pathRelativity is missing
 * path is considered absolute.
 * @param {*} db
 * @param {*} pkg
 * @param {*} zapFilePath
 * @param {*} packageMatch
 * @param {*} defaultZclMetafile
 * @param {*} defaultTemplateFile
 * @returns pkg information based on a match
 */
async function importSinglePackage(
  db,
  pkg,
  zapFilePath,
  packageMatch,
  defaultZclMetafile = null,
  defaultTemplateFile = null
) {
  let autoloading = true
  let absPath = getPkgPath(pkg, zapFilePath)
  let pkgId = await queryPackage.getPackageIdByPathAndTypeAndVersion(
    db,
    absPath,
    pkg.type,
    pkg.version
  )

  if (pkgId != null) {
    // Perfect match found, return it and be done.
    return {
      packageId: pkgId,
      packageType: pkg.type,
    }
  }

  // Look under defaultZclMetafile and defaultTemplateFile when match is not
  // found.
  //eslint-disable-next-line
  let filePathToSearch = pkg.path.split(/.*[\/|\\]/).pop()
  let zclFile = Array.isArray(defaultZclMetafile)
    ? defaultZclMetafile.find((f) => f != null && f.includes(filePathToSearch))
    : typeof defaultZclMetafile === 'string' &&
      defaultZclMetafile.includes(filePathToSearch)
    ? defaultZclMetafile
    : null
  let templateFile = Array.isArray(defaultTemplateFile)
    ? defaultTemplateFile.find((f) => f != null && f.includes(filePathToSearch))
    : typeof defaultTemplateFile === 'string' &&
      defaultTemplateFile.includes(filePathToSearch)
    ? defaultTemplateFile
    : null

  if (zclFile != null) {
    // removing any double / since that can fail the search
    //eslint-disable-next-line
    zclFile = zclFile.replace(/\/+/g, '/')
    pkgId = await queryPackage.getPackageIdByPathAndTypeAndVersion(
      db,
      zclFile,
      pkg.type,
      pkg.version
    )
  } else if (templateFile != null) {
    // removing any double / since that can fail the search
    //eslint-disable-next-line
    templateFile = templateFile.replace(/\/+/g, '/')
    pkgId = await queryPackage.getPackageIdByPathAndTypeAndVersion(
      db,
      templateFile,
      pkg.type,
      pkg.version
    )
  }

  if (pkgId != null) {
    // Argument match found, return it and be done.
    env.logError(
      `Package match found for ${pkg.path} from the passed arguments: ${
        zclFile ? zclFile : templateFile
      }`
    )
    return {
      packageId: pkgId,
      packageType: pkg.type,
    }
  }

  // No perfect match.
  // We will attempt to simply load up the package as it is listed in the file.
  if (autoloading && !(packageMatch === dbEnum.packageMatch.ignore)) {
    try {
      return await autoLoadPackage(db, pkg, absPath)
    } catch (err) {
      if (dbEnum.packageMatch == dbEnum.packageMatch.strict) {
        throw err
      }
    }
  }

  // Now we have to perform the guessing logic.
  env.logDebug(
    'Packages from the file did not match loaded packages making best bet.'
  )
  let packages = await queryPackage.getPackagesByType(db, pkg.type)

  // If there isn't any, then abort, but if there is only one, use it.
  if (packages.length == 0) {
    if (pkg.type == dbEnum.packageType.genTemplatesJson) {
      // We don't throw exception for genTemplatesJson, we can survive without.
      env.logDebug(`No packages of type ${pkg.type} found in the database.`)
      return null
    } else {
      env.logError(`No packages of type ${pkg.type} found in the database.`)
      return null
    }
  } else if (packages.length == 1) {
    env.logDebug(
      `Only one package of given type ${pkg.type} present. Using it.`
    )
    return {
      packageId: packages[0].id,
      packageType: pkg.type,
    }
  }

  // Moving on. We have more than one package, so we have to
  // make a smart decision.
  //

  // First narrow down to the category.
  let categoryMatch = packages.filter((p) => p.category == pkg.category)
  if (categoryMatch.length == 1) {
    env.logDebug(
      `Only one package of given type ${pkg.type} and category ${pkg.category} present. Using it.`
    )
    return {
      packageId: categoryMatch[0].id,
      packageType: pkg.type,
    }
  }

  // Filter to just the ones that match the version
  let versionMatch = packages.filter((p) => p.version == pkg.version)
  // If there isn't any abort, if there is only one, use it.
  if (versionMatch.length == 0 && packageMatch === dbEnum.packageMatch.strict) {
    let msg = `No packages of type ${pkg.type} that match version ${pkg.version} found in the database.`
    if (pkg.type == dbEnum.packageType.genTemplatesJson) {
      // We don't throw exception for genTemplatesJson, we can survive without.
      env.logDebug(msg)
      return null
    } else {
      throw new Error(msg)
    }
  } else if (versionMatch.length == 1) {
    env.logDebug(
      `Only one package of given type ${pkg.type} and version ${pkg.version} present. Using it.`
    )
    return {
      packageId: versionMatch[0].id,
      packageType: pkg.type,
    }
  }

  // Neither category match, nor version match had only one version.

  // We now know we have more than 1 matching package. Find best bet.
  let existingPackages = packages.filter(
    (p) => fs.existsSync(p.path) && p.path === absPath
  )

  if (existingPackages.length == 1) {
    // Only one exists, use that one.
    let p = existingPackages[0]
    env.logWarning(`Using only package that exists:${p.id}.`)
    return {
      packageId: p.id,
      packageType: pkg.type,
    }
  } else if (existingPackages.length > 1) {
    // More than one exists. Use the first one.
    let p = existingPackages[0]
    env.logWarning(
      `Using first package that exists out of ${existingPackages.length}: ${p.id}.`
    )
    return {
      packageId: p.id,
      packageType: pkg.type,
    }
  } else {
    let p = packages[0]
    let pkgPaths = packages.map((p) => p.path)
    let packageNameMatch = packages.find(
      (p) => p.path.includes(filePathToSearch) && fs.existsSync(p.path)
    )
    if (packageMatch) {
      p = packageNameMatch
      env.logError(
        `None of packages exist for ${pkg.path}, so using one which matches the file name: ${p.path} from ${pkgPaths}.`
      )
    } else {
      // None exists, so use the first one from 'packages'.
      env.logError(
        `None of packages exist for ${pkg.path}, so using first one overall: ${p.path} from ${pkgPaths}.`
      )
    }
    return {
      packageId: p.id,
      packageType: pkg.type,
    }
  }
}

/**
 * Convert the array of results into a more palatable value.
 * Resolves an array of { packageId:, packageType:} objects into { zclPackageId: id, templateIds: [] }
 *
 * @param {*} data
 * @returns an object that contains session ids.
 */
function convertPackageResult(data) {
  let ret = {
    zclPackageId: null,
    templateIds: [],
    optionalIds: [],
  }
  data.forEach((obj) => {
    if (obj == null) return null
    if (obj.packageType == dbEnum.packageType.zclProperties) {
      ret.zclPackageId = obj.packageId
    } else if (obj.packageType == dbEnum.packageType.genTemplatesJson) {
      ret.templateIds.push(obj.packageId)
    } else {
      ret.optionalIds.push(obj.packageId)
    }
  })
  return ret
}

/**
 *
 * @param {*} db
 * @param {*} packages
 * @param {*} zapFilePath
 * @param {*} packageMatch
 * @param {*} defaultZclMetafile
 * @param {*} defaultTemplateFile
 * @returns a promise that resolves into an object containing: packageId and otherIds
 */
async function importPackages(
  db,
  packages,
  zapFilePath,
  packageMatch,
  defaultZclMetafile = null,
  defaultTemplateFile = null
) {
  let allQueries = []
  if (packages != null) {
    env.logDebug(`Loading ${packages.length} packages`)
    packages.forEach((p) => {
      allQueries.push(
        importSinglePackage(
          db,
          p,
          zapFilePath,
          packageMatch,
          defaultZclMetafile,
          defaultTemplateFile
        )
      )
    })
  }
  let data = await Promise.all(allQueries)
  return convertPackageResult(data)
}

async function importEndpointTypes(
  db,
  sessionId,
  allZclPackageIds,
  endpointTypes,
  endpoints
) {
  let sortedEndpoints = {}
  if (endpoints != null) {
    endpoints.forEach((ep) => {
      let eptIndex = ep.endpointTypeIndex
      if (sortedEndpoints[eptIndex] == null) sortedEndpoints[eptIndex] = []
      sortedEndpoints[eptIndex].push(ep)
    })
  }

  if (endpointTypes != null) {
    env.logDebug(`Loading ${endpointTypes.length} endpoint types`)
    let specCheckComplianceMessage = ''
    const specMessageIndent = '\n  - '
    const dottedLine =
      '\n\n🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨\n\n'
    const specCheckComplianceFailureTitle =
      'Application is failing the Specification as follows: \n'
    for (let i = 0; i < endpointTypes.length; i++) {
      let endpointTypeId = await queryImpexp.importEndpointType(
        db,
        sessionId,
        allZclPackageIds,
        endpointTypes[i]
      )
      let endpointId = ''
      if (sortedEndpoints[i]) {
        for (let j = 0; j < sortedEndpoints[i].length; j++) {
          endpointId = sortedEndpoints[i][j].endpointId
          let endpoint = await queryImpexp.importEndpoint(
            db,
            sessionId,
            sortedEndpoints[i][j],
            endpointTypeId
          )
        }
      }
      let clusters = endpointTypes[i].clusters
      if (clusters) {
        for (let k = 0; k < clusters.length; k++) {
          let endpointClusterId =
            await queryImpexp.importClusterForEndpointType(
              db,
              allZclPackageIds,
              endpointTypeId,
              clusters[k]
            )

          if ('commands' in clusters[k]) {
            for (let l = 0; l < clusters[k].commands.length; l++) {
              await queryImpexp.importCommandForEndpointType(
                db,
                allZclPackageIds,
                endpointTypeId,
                endpointClusterId,
                clusters[k].commands[l]
              )
            }
          }

          if ('attributes' in clusters[k]) {
            for (let m = 0; m < clusters[k].attributes.length; m++) {
              await queryImpexp.importAttributeForEndpointType(
                db,
                allZclPackageIds,
                endpointTypeId,
                endpointClusterId,
                clusters[k].attributes[m],
                clusters[k]
              )
            }
          }

          if ('events' in clusters[k]) {
            for (let n = 0; n < clusters[k].events.length; n++) {
              await queryImpexp.importEventForEndpointType(
                db,
                allZclPackageIds,
                endpointTypeId,
                endpointClusterId,
                clusters[k].events[n]
              )
            }
          }
        }
      }
      /**
       * The following code looks into the spec conformance coming from the xml
       * loading. This involves compliance of between device types, clusters,
       * commands and attributes on an endpoint.
       */
      // Clusters on an endpoint type
      let endpointTypeClusters =
        await queryZcl.selectEndpointTypeClustersByEndpointTypeId(
          db,
          endpointTypeId
        )
      let endpointTypeClusterRefMap = {}
      for (let len = 0; len < endpointTypeClusters.length; len++) {
        let epc = endpointTypeClusters[len]
        endpointTypeClusterRefMap[epc.clusterRef] =
          endpointTypeClusterRefMap[epc.clusterRef] || {}
        endpointTypeClusterRefMap[epc.clusterRef][epc.side] = epc.enabled
      }

      // Attributes on an endpoint type
      let endpointTypeAttributes =
        await queryZcl.selectEndpointTypeAttributesByEndpointId(
          db,
          endpointTypeId
        )
      let endpointTypeAttributeRefMap = {}
      for (let len = 0; len < endpointTypeAttributes.length; len++) {
        let epa = endpointTypeAttributes[len]
        endpointTypeAttributeRefMap[epa.attributeRef] = epa.included
      }

      // Commands on an endpoint type
      let endpointTypeCommands =
        await queryZcl.selectEndpointTypeCommandsByEndpointId(
          db,
          endpointTypeId
        )
      let endpointTypeCommandRefMap = {}
      for (let len = 0; len < endpointTypeCommands.length; len++) {
        let epc = endpointTypeCommands[len]
        endpointTypeCommandRefMap[epc.commandRef] =
          endpointTypeCommandRefMap[epc.commandRef] || {}
        endpointTypeCommandRefMap[epc.commandRef]['incoming'] = epc.incoming
        endpointTypeCommandRefMap[epc.commandRef]['outgoing'] = epc.outgoing
      }

      // Device types on an endpoint type
      let endpointTypeDeviceTypes =
        await queryDeviceType.selectDeviceTypesByEndpointTypeId(
          db,
          endpointTypeId
        )

      // Clusters associated with device types on an endpoint type
      let deviceTypeClustersOnEndpointType = []

      // Attributes associated with device types on an endpoint type
      let deviceTypeAttributesOnEndpointType = []

      // Commands associated with device types on an endpoint type
      let deviceTypeCommandsOnEndpointType = []

      // Initialize the device type clusters, attributes and commands based on
      // device types on an endpoint
      for (
        let eptDtIndex = 0;
        eptDtIndex < endpointTypeDeviceTypes.length;
        eptDtIndex++
      ) {
        let deviceTypeClusters =
          await queryDeviceType.selectDeviceTypeClustersByDeviceTypeRef(
            db,
            endpointTypeDeviceTypes[eptDtIndex].deviceTypeRef
          )
        deviceTypeClustersOnEndpointType =
          deviceTypeClustersOnEndpointType.concat(deviceTypeClusters)
        let deviceTypeAttributes =
          await queryDeviceType.selectDeviceTypeAttributesByDeviceTypeRef(
            db,
            endpointTypeDeviceTypes[eptDtIndex].deviceTypeRef
          )
        deviceTypeAttributes.forEach(
          (da) =>
            (da.deviceTypeRef =
              endpointTypeDeviceTypes[eptDtIndex].deviceTypeRef)
        )
        deviceTypeAttributesOnEndpointType =
          deviceTypeAttributesOnEndpointType.concat(deviceTypeAttributes)
        let deviceTypeCommands =
          await queryDeviceType.selectDeviceTypeCommandsByDeviceTypeRef(
            db,
            endpointTypeDeviceTypes[eptDtIndex].deviceTypeRef
          )
        deviceTypeCommands.forEach(
          (dc) =>
            (dc.deviceTypeRef =
              endpointTypeDeviceTypes[eptDtIndex].deviceTypeRef)
        )
        deviceTypeCommandsOnEndpointType =
          deviceTypeCommandsOnEndpointType.concat(deviceTypeCommands)
      }

      // Cluster compliance as per the spec. Checking if a device type requires
      // a cluster that is not enabled on an endpoint type
      for (let dtc = 0; dtc < deviceTypeClustersOnEndpointType.length; dtc++) {
        let isDeviceTypeClientClusterFound =
          endpointTypeClusterRefMap?.[
            deviceTypeClustersOnEndpointType[dtc].clusterRef
          ]?.['client']
        let isDeviceTypeServerClusterFound =
          endpointTypeClusterRefMap?.[
            deviceTypeClustersOnEndpointType[dtc].clusterRef
          ]?.['server']
        let clusterSpecComplianceMessage = ''
        if (
          deviceTypeClustersOnEndpointType[dtc].includeClient &&
          !isDeviceTypeClientClusterFound
        ) {
          let deviceType = await queryDeviceType.selectDeviceTypeById(
            db,
            deviceTypeClustersOnEndpointType[dtc].deviceTypeRef
          )
          clusterSpecComplianceMessage =
            '⚠ Check Spec Compliance on endpoint: ' +
            endpointId +
            ', device type: ' +
            deviceType.name +
            ', cluster: ' +
            deviceTypeClustersOnEndpointType[dtc].clusterName +
            ' client needs to be enabled'
          specCheckComplianceMessage = specCheckComplianceMessage.concat(
            specMessageIndent,
            clusterSpecComplianceMessage
          )
          querySessionNotice.setNotification(
            db,
            'WARNING',
            clusterSpecComplianceMessage,
            sessionId,
            1,
            0
          )
        }
        if (
          deviceTypeClustersOnEndpointType[dtc].includeServer &&
          !isDeviceTypeServerClusterFound
        ) {
          let deviceType = await queryDeviceType.selectDeviceTypeById(
            db,
            deviceTypeClustersOnEndpointType[dtc].deviceTypeRef
          )
          clusterSpecComplianceMessage =
            '⚠ Check Spec Compliance on endpoint: ' +
            endpointId +
            ', device type: ' +
            deviceType.name +
            ', cluster: ' +
            deviceTypeClustersOnEndpointType[dtc].clusterName +
            ' server needs to be enabled'
          specCheckComplianceMessage = specCheckComplianceMessage.concat(
            specMessageIndent,
            clusterSpecComplianceMessage
          )
          querySessionNotice.setNotification(
            db,
            'WARNING',
            clusterSpecComplianceMessage,
            sessionId,
            1,
            0
          )
        }
      }

      // Attribute compliance as per the spec. Checking if a device type requires
      // an attribute that is not enabled on an endpoint type
      for (
        let dta = 0;
        dta < deviceTypeAttributesOnEndpointType.length;
        dta++
      ) {
        let isAttributeFound =
          endpointTypeAttributeRefMap?.[
            deviceTypeAttributesOnEndpointType[dta].attributeRef
          ]
        if (!isAttributeFound) {
          let queryDeviceTypeClusterInfo =
            await queryDeviceType.selectDeviceTypeClusterByDeviceTypeClusterId(
              db,
              deviceTypeAttributesOnEndpointType[dta].deviceTypeClusterRef
            )
          if (
            queryDeviceTypeClusterInfo.includeClient ||
            queryDeviceTypeClusterInfo.includeServer
          ) {
            if (deviceTypeAttributesOnEndpointType[dta].attributeRef != null) {
              let cluster = await queryZcl.selectClusterById(
                db,
                queryDeviceTypeClusterInfo.clusterRef
              )
              let deviceType = await queryDeviceType.selectDeviceTypeById(
                db,
                deviceTypeAttributesOnEndpointType[dta].deviceTypeRef
              )
              // Leaving out global attributes
              let attributeSpecComplianceMessage =
                '⚠ Check Spec Compliance on endpoint: ' +
                endpointId +
                ', device type: ' +
                deviceType.name +
                ', cluster: ' +
                cluster.name +
                ', attribute: ' +
                deviceTypeAttributesOnEndpointType[dta].name +
                ' needs to be enabled'
              specCheckComplianceMessage = specCheckComplianceMessage.concat(
                specMessageIndent,
                attributeSpecComplianceMessage
              )
              querySessionNotice.setNotification(
                db,
                'WARNING',
                attributeSpecComplianceMessage,
                sessionId,
                1,
                0
              )
            }
          }
        }
      }

      // Command compliance as per the spec. Checking if a device type requires
      // a command that is not enabled on an endpoint type
      for (let dtc = 0; dtc < deviceTypeCommandsOnEndpointType.length; dtc++) {
        let isCommandIncomingFound =
          endpointTypeCommandRefMap?.[
            deviceTypeCommandsOnEndpointType[dtc].commandRef
          ]?.['incoming']
        let isCommandOutgoingFound =
          endpointTypeCommandRefMap?.[
            deviceTypeCommandsOnEndpointType[dtc].commandRef
          ]?.['outgoing']
        if (!(isCommandIncomingFound && isCommandOutgoingFound)) {
          let commandSource = deviceTypeCommandsOnEndpointType[dtc].source
          let queryDeviceTypeClusterInfo =
            await queryDeviceType.selectDeviceTypeClusterByDeviceTypeClusterId(
              db,
              deviceTypeCommandsOnEndpointType[dtc].deviceTypeClusterRef
            )
          let cluster = await queryZcl.selectClusterById(
            db,
            queryDeviceTypeClusterInfo.clusterRef
          )
          let deviceType = await queryDeviceType.selectDeviceTypeById(
            db,
            deviceTypeCommandsOnEndpointType[dtc].deviceTypeRef
          )
          let commandSpecComplianceMessage = ''
          if (
            queryDeviceTypeClusterInfo.includeClient &&
            commandSource == 'client' &&
            !isCommandOutgoingFound
          ) {
            commandSpecComplianceMessage =
              '⚠ Check Spec Compliance on endpoint: ' +
              endpointId +
              ', device type: ' +
              deviceType.name +
              ', cluster: ' +
              cluster.name +
              ' client, command: ' +
              deviceTypeCommandsOnEndpointType[dtc].name +
              ' outgoing needs to be enabled'
            specCheckComplianceMessage = specCheckComplianceMessage.concat(
              specMessageIndent,
              commandSpecComplianceMessage
            )
            querySessionNotice.setNotification(
              db,
              'WARNING',
              commandSpecComplianceMessage,
              sessionId,
              1,
              0
            )
          }

          if (
            queryDeviceTypeClusterInfo.includeClient &&
            commandSource == 'server' &&
            !isCommandIncomingFound
          ) {
            commandSpecComplianceMessage =
              '⚠ Check Spec Compliance on endpoint: ' +
              endpointId +
              ', device type: ' +
              deviceType.name +
              ', cluster: ' +
              cluster.name +
              ' client, command: ' +
              deviceTypeCommandsOnEndpointType[dtc].name +
              ' incoming needs to be enabled'
            specCheckComplianceMessage = specCheckComplianceMessage.concat(
              specMessageIndent,
              commandSpecComplianceMessage
            )
            querySessionNotice.setNotification(
              db,
              'WARNING',
              commandSpecComplianceMessage,
              sessionId,
              1,
              0
            )
          }

          if (
            queryDeviceTypeClusterInfo.includeServer &&
            commandSource == 'client' &&
            !isCommandIncomingFound
          ) {
            commandSpecComplianceMessage =
              '⚠ Check Spec Compliance on endpoint: ' +
              endpointId +
              ', device type: ' +
              deviceType.name +
              ', cluster: ' +
              cluster.name +
              ' server, command: ' +
              deviceTypeCommandsOnEndpointType[dtc].name +
              ' incoming needs to be enabled'
            specCheckComplianceMessage = specCheckComplianceMessage.concat(
              specMessageIndent,
              commandSpecComplianceMessage
            )
            querySessionNotice.setNotification(
              db,
              'WARNING',
              commandSpecComplianceMessage,
              sessionId,
              1,
              0
            )
          }

          if (
            queryDeviceTypeClusterInfo.includeServer &&
            commandSource == 'server' &&
            !isCommandOutgoingFound
          ) {
            commandSpecComplianceMessage =
              '⚠ Check Spec Compliance on endpoint: ' +
              endpointId +
              ', device type: ' +
              deviceType.name +
              ', cluster: ' +
              cluster.name +
              ' server, command: ' +
              deviceTypeCommandsOnEndpointType[dtc].name +
              ' outgoing needs to be enabled'
            specCheckComplianceMessage = specCheckComplianceMessage.concat(
              specMessageIndent,
              commandSpecComplianceMessage
            )
            querySessionNotice.setNotification(
              db,
              'WARNING',
              commandSpecComplianceMessage,
              sessionId,
              1,
              0
            )
          }
        }
      }
    }
    if (specCheckComplianceMessage.length > 0) {
      specCheckComplianceMessage = dottedLine.concat(
        specCheckComplianceFailureTitle,
        specCheckComplianceMessage,
        dottedLine
      )
      console.log(specCheckComplianceMessage)
    }
  }
}

/**
 * Given a state object, this method returns a promise that resolves
 * with the succesfull writing into the database.
 *
 * @param {*} db
 * @param {*} state
 * @param {*} sessionId If null, then new session will get
 *              created, otherwise it loads the data into an
 *              existing session. Previous session data is not deleted.
 * @param {*} packageMatch One of the package match strategies. See dbEnum.packageMatch
 * @param {*} defaultZclMetafile
 * @param {*} defaultTemplateFile
 * @returns a promise that resolves into a sessionId that was created.
 */
async function jsonDataLoader(
  db,
  state,
  sessionId,
  packageMatch,
  defaultZclMetafile,
  defaultTemplateFile
) {
  // Initially clean up all the packages from the session.

  // Loading all packages before custom xml to make sure clusterExtensions are
  // handled properly
  let topLevelPackages = state.package.filter(
    (pkg) =>
      pkg.type == dbEnum.packageType.zclProperties ||
      pkg.type == dbEnum.packageType.genTemplatesJson
  )
  let mainPackageData = await importPackages(
    db,
    topLevelPackages,
    state.filePath,
    packageMatch,
    defaultZclMetafile,
    defaultTemplateFile
  )
  mainPackageData.sessionId = sessionId

  let mainPackagePromise = []
  mainPackagePromise.push(
    queryPackage.insertSessionPackage(
      db,
      sessionId,
      mainPackageData.zclPackageId
    )
  )

  if (mainPackageData.templateIds.length > 0) {
    mainPackageData.templateIds.forEach((templateId) => {
      mainPackagePromise.push(
        queryPackage.insertSessionPackage(db, sessionId, templateId)
      )
    })
  }

  if (mainPackageData.optionalIds.length > 0) {
    mainPackageData.optionalIds.forEach((optionalId) =>
      mainPackagePromise.push(
        queryPackage.insertSessionPackage(db, sessionId, optionalId)
      )
    )
  }
  await Promise.all(mainPackagePromise)

  // Loading custom xml after the basic xml packages have been loaded

  let zclXmlStandAlonePackages = state.package.filter(
    (pkg) => pkg.type == dbEnum.packageType.zclXmlStandalone
  )

  // First gather all package Ids...
  let allExistingPackageIds = await Promise.all(
    state.package.map(async (pkg) => {
      let packageId = await queryPackage.getPackageIdByPathAndTypeAndVersion(
        db,
        getPkgPath(pkg, state.filePath),
        pkg.type,
        pkg.version
      )
      return {
        packageId: packageId,
        packageType: pkg.type,
      }
    })
  )

  // ... some are null, which means that they need to be loaded, some are not null.
  // Lets gather the actual packages that did not have a pkgId, so that they will be loaded
  let packagesThatWillHaveToBeLoaded = allExistingPackageIds
    .map((pkg, index) => {
      // packages that is new to DB will carry null value.
      if (pkg.packageId) {
        return null
      } else {
        return state.package[index]
      }
    })
    .filter((x) => x)

  let existingCustomXmlPackageIds = allExistingPackageIds
    .filter(
      (p) =>
        p.packageType === dbEnum.packageType.zclXmlStandalone &&
        p.packageId != null
    )
    .map((p) => p.packageId)

  // New pkgIds will contain the IDs of the packages that we had to load...
  let newlyLoadedCustomPackageIds = (
    await Promise.all(
      packagesThatWillHaveToBeLoaded.map((pkg) => {
        let filePath = getPkgPath(pkg, state.filePath)
        if (pkg.type === dbEnum.packageType.zclXmlStandalone) {
          return zclLoader.loadIndividualFile(db, filePath, sessionId)
        } else {
          return {}
        }
      })
    )
  )
    .filter((p) => p.succeeded)
    .map((p) => p.packageId)

  let standAlonePackageData = await importPackages(
    db,
    zclXmlStandAlonePackages,
    state.filePath,
    packageMatch
  )
  standAlonePackageData.sessionId = sessionId

  // packageData: { sessionId, packageId, otherIds, optionalIds}
  let optionalPackagePromises = []
  if (standAlonePackageData.optionalIds.length > 0) {
    standAlonePackageData.optionalIds.forEach((optionalId) =>
      optionalPackagePromises.push(
        queryPackage.insertSessionPackage(db, sessionId, optionalId)
      )
    )
  }
  await Promise.all(optionalPackagePromises)

  let promisesStage1 = [] // Stage 1 is endpoint types
  let promisesStage2 = [] // Stage 2 is endpoints, which require endpoint types to be loaded prior.

  if ('keyValuePairs' in state) {
    promisesStage1.push(
      importSessionKeyValues(db, sessionId, state.keyValuePairs)
    )
  }

  if ('endpointTypes' in state) {
    const allZclPackageIds = []
    allZclPackageIds.push(mainPackageData.zclPackageId)
    allZclPackageIds.push(...existingCustomXmlPackageIds)
    allZclPackageIds.push(...newlyLoadedCustomPackageIds)
    promisesStage1.push(
      importEndpointTypes(
        db,
        sessionId,
        allZclPackageIds,
        state.endpointTypes,
        state.endpoints
      )
    )
  }

  await Promise.all(promisesStage1)
  await Promise.all(promisesStage2)
  await querySession.setSessionClean(db, sessionId)

  if ('package' in state) {
    await Promise.all(
      state.package.map(async (pkg) => {
        let pkgFilePath = getPkgPath(pkg, state.filePath)

        let sessionPkgs = await queryPackage.getSessionPackagesByType(
          db,
          sessionId,
          pkg.type
        )
        let invalidSessionPkgs = sessionPkgs.filter(
          (x) => x.path !== pkgFilePath
        )
        let validSessionPkgId =
          await queryPackage.getPackageIdByPathAndTypeAndVersion(
            db,
            pkgFilePath,
            pkg.type,
            pkg.version
          )

        if (validSessionPkgId != null && invalidSessionPkgs.length) {
          await Promise.all(
            invalidSessionPkgs.map((y) => {
              env.logDebug(
                `Disabling/removing invalid session package. sessionId(${sessionId}), packageId(${y.id}), path(${y.path})`
              )
              return queryPackage.deleteSessionPackage(db, sessionId, y.id)
            })
          )

          env.logDebug(
            `Enabling session package. sessionId(${sessionId}), packageId(${validSessionPkgId})`
          )
          await queryPackage.insertSessionPackage(
            db,
            sessionId,
            validSessionPkgId
          )
        }
      })
    )
  }

  return {
    sessionId: mainPackageData.sessionId,
    zclPackageId: mainPackageData.zclPackageId,
    templateIds: mainPackageData.templateIds,
    errors: [],
    warnings: [],
  }
}

// This function cleans up some backwards-compatible problems in zap
// files.
function cleanJsonState(state) {
  if (!('featureLevel' in state)) {
    state.featureLevel = 0
  }
}

/**
 * Parses JSON file and creates a state object out of it, which is passed further down the chain.
 *
 * @param {*} filePath
 * @param {*} data
 * @param {*} defaultZclMetafile
 * @param {*} defaultTemplateFile
 * @returns Promise of parsed JSON object
 */
async function readJsonData(
  filePath,
  data,
  defaultZclMetafile,
  defaultTemplateFile
) {
  let state = JSON.parse(data)

  cleanJsonState(state)
  let status = util.matchFeatureLevel(state.featureLevel, filePath)

  if (status.match) {
    if (!('keyValuePairs' in state)) {
      state.keyValuePairs = []
    }
    state.filePath = filePath
    state.keyValuePairs.push({
      key: dbEnum.sessionKey.filePath,
      value: filePath,
    })
    state.loader = jsonDataLoader
    return state
  } else {
    throw new Error(status.message)
  }
}

exports.readJsonData = readJsonData
