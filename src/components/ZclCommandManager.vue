<!--
Copyright (c) 2008,2020 Silicon Labs.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->
<template>
  <div>
    <div v-if="commandData.length > 0">
      <q-table
        class="my-sticky-header-table"
        :rows="commandData"
        :columns="columns"
        row-key="<b>name</b>"
        dense
        flat
        binary-state-sort
        v-model:pagination="pagination"
      >
        <template v-slot:header="props">
          <q-tr :props="props">
            <q-th v-for="col in props.cols" :key="col.name" :props="props">
              {{ col.label }}
            </q-th>
          </q-tr>
        </template>
        <template v-slot:body="props">
          <q-tr :props="props">
            <q-td key="status" :props="props" class="q-px-none">
              <q-icon
                v-show="displayCommandWarning(props.row)"
                name="warning"
                class="text-amber"
                style="font-size: 1.5rem"
              />
              <q-tooltip
                v-if="displayCommandWarning(props.row)"
                anchor="top middle"
                self="bottom middle"
                :offset="[10, 10]"
              >
                <div
                  v-for="(warning, index) in getCommandWarning(props.row)"
                  :key="index"
                >
                  {{ warning }}
                </div>
              </q-tooltip>
            </q-td>
            <q-td key="out" :props="props" auto-width>
              <q-checkbox
                class="q-mt-xs"
                v-model="selectionOut"
                :val="hashCommandIdClusterId(props.row.id, selectedCluster.id)"
                v-show="
                  (selectionClients.includes(selectedCluster.id) &&
                    props.row.source == 'client') ||
                  (selectionServers.includes(selectedCluster.id) &&
                    props.row.source == 'server') ||
                  props.row.source == 'either'
                "
                indeterminate-value="false"
                keep-color
                @update:model-value="
                  handleCommandSelection(
                    selectionOut,
                    'selectedOut',
                    props.row,
                    selectedCluster.id
                  )
                "
              />
            </q-td>
            <q-td key="in" :props="props" auto-width class="v-step-15">
              <q-checkbox
                class="q-mt-xs"
                v-model="selectionIn"
                :val="hashCommandIdClusterId(props.row.id, selectedCluster.id)"
                indeterminate-value="false"
                keep-color
                v-show="
                  (selectionServers.includes(selectedCluster.id) &&
                    props.row.source == 'client') ||
                  (selectionClients.includes(selectedCluster.id) &&
                    props.row.source == 'server') ||
                  props.row.source == 'either'
                "
                @update:model-value="
                  handleCommandSelection(
                    selectionIn,
                    'selectedIn',
                    props.row,
                    selectedCluster.id
                  )
                "
              />
            </q-td>
            <q-td key="direction" :props="props" auto-width>{{
              props.row.source === 'client'
                ? 'Client ➞ Server'
                : props.row.source === 'server'
                  ? 'Server ➞ Client'
                  : 'Client ↔ Server'
            }}</q-td>
            <q-td key="commandId" :props="props" auto-width>{{
              asHex(props.row.code, 2)
            }}</q-td>
            <q-td key="commandName" :props="props" auto-width>{{
              props.row.label
            }}</q-td>
            <q-td key="required" :props="props" auto-width>
              {{ isCommandRequired(props.row) ? 'Yes' : '' }}
            </q-td>
            <q-td key="mfgId" :props="props" auto-width
              >{{
                selectedCluster.manufacturerCode
                  ? asHex(selectedCluster.manufacturerCode, 4)
                  : props.row.manufacturerCode
                    ? asHex(props.row.manufacturerCode, 4)
                    : '-'
              }}
            </q-td>
          </q-tr>
        </template>
      </q-table>
    </div>
    <div v-else><br />{{ noCommandsMessage }}</div>
  </div>
</template>

<script>
import * as Util from '../util/util.js'
import EditableAttributesMixin from '../util/editable-attributes-mixin.js'
import uiOptions from '../util/ui-options'
import CommonMixin from '../util/common-mixin'

export default {
  name: 'ZclCommandManager',
  mixins: [EditableAttributesMixin, uiOptions, CommonMixin],
  computed: {
    commandData: {
      get() {
        return this.$store.state.zap.commands.filter((command) => {
          return this.individualClusterFilterString == ''
            ? true
            : command.name
                .toLowerCase()
                .includes(this.individualClusterFilterString.toLowerCase())
        })
      }
    },
    selectionIn: {
      get() {
        return this.$store.state.zap.commandView.selectedIn
      }
    },
    selectionOut: {
      get() {
        return this.$store.state.zap.commandView.selectedOut
      }
    },
    requiredCommands: {
      get() {
        return this.$store.state.zap.commandView.requiredCommands
      }
    }
  },
  methods: {
    /* Display warnings if command required by device type is disabled,
       or if command state does not match mandatory or notSupported conformance.
       Two types of warnings can be displayed at the same time. */
    displayCommandWarning(row) {
      return (
        (this.enableFeature &&
          ((this.commandsRequiredByConform[row.id] &&
            this.isCommandUnselected(row)) ||
            (this.commandsNotSupportedByConform[row.id] &&
              !this.isCommandUnselected(row)))) ||
        this.isRequiredCommandUnselected(row)
      )
    },
    getCommandWarning(row) {
      let warnings = []
      if (
        this.commandsRequiredByConform[row.id] &&
        this.isCommandUnselected(row) &&
        this.enableFeature
      ) {
        warnings.push(this.commandsRequiredByConform[row.id])
      }
      if (
        this.commandsNotSupportedByConform[row.id] &&
        !this.isCommandUnselected(row) &&
        this.enableFeature
      ) {
        warnings.push(this.commandsNotSupportedByConform[row.id])
      }
      if (this.isRequiredCommandUnselected(row)) {
        warnings.push(this.defaultWarning)
      }
      return warnings
    },
    isCommandUnselected(row) {
      return (
        (((this.selectionClients.includes(this.selectedCluster.id) &&
          row.source == 'client') ||
          (this.selectionServers.includes(this.selectedCluster.id) &&
            row.source == 'server')) &&
          !this.selectionOut.includes(
            this.hashCommandIdClusterId(row.id, this.selectedCluster.id)
          )) ||
        (((this.selectionClients.includes(this.selectedCluster.id) &&
          row.source == 'server') ||
          (this.selectionServers.includes(this.selectedCluster.id) &&
            row.source == 'client')) &&
          !this.selectionIn.includes(
            this.hashCommandIdClusterId(row.id, this.selectedCluster.id)
          ))
      )
    },
    isRequiredCommandUnselected(row) {
      return this.isCommandUnselected(row) && this.isCommandRequired(row)
    },
    handleCommandSelection(list, listType, commandData, clusterId) {
      // We determine the ID that we need to toggle within the list.
      // This ID comes from hashing the base Command ID and cluster data.
      let indexOfValue = list.indexOf(
        this.hashCommandIdClusterId(commandData.id, clusterId)
      )

      let addedValue
      if (indexOfValue === -1) {
        addedValue = true
      } else {
        addedValue = false
      }

      this.setRequiredElementNotifications(commandData, addedValue, 'commands')

      let editContext = {
        action: 'boolean',
        endpointTypeIdList: this.endpointTypeIdList,
        id: commandData.id,
        value: addedValue,
        listType: listType,
        clusterRef: clusterId,
        commandSide: commandData.source
      }
      this.$store.dispatch('zap/updateSelectedCommands', editContext)
    },
    isCommandRequired(command) {
      return this.requiredCommands.includes(command.id) || !command.isOptional
    },
    hashCommandIdClusterId(commandId, clusterId) {
      return Util.cantorPair(commandId, clusterId)
    }
  },
  data() {
    return {
      noCommandsMessage: 'No commands available for this cluster.',
      defaultWarning:
        'This command is mandatory for the cluster and device type configuration you have enabled',
      pagination: {
        rowsPerPage: 50
      },
      columns: [
        {
          name: 'status',
          required: false,
          label: '',
          align: 'left',
          style: 'width:1%'
        },
        {
          name: 'out',
          label: 'Out',
          field: 'out',
          align: 'left',
          sortable: true,
          style: 'width:1%'
        },
        {
          name: 'in',
          label: 'In',
          field: 'in',
          align: 'left',
          sortable: true,
          style: 'width:1%'
        },
        {
          name: 'direction',
          label: 'Direction',
          field: 'direction',
          align: 'left',
          sortable: true,
          style: 'width:1%'
        },
        {
          name: 'commandId',
          align: 'left',
          label: 'ID',
          field: 'commandId',
          sortable: true,
          style: 'width:1%'
        },
        {
          name: 'commandName',
          align: 'left',
          label: 'Command',
          field: 'commandName',
          sortable: true,
          style: 'width:20%'
        },
        {
          name: 'required',
          align: 'left',
          label: 'Required',
          field: 'required',
          sortable: true,
          style: 'width:10%'
        },
        {
          name: 'mfgId',
          align: 'left',
          label: 'Manufacturing Id',
          field: 'mfgId',
          sortable: true,
          style: 'width:10%'
        }
      ]
    }
  }
}
</script>
