<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { api, type FileFolder } from '../api'

const props = defineProps<{
  parentId: string | null
  parentPath: string
  documentId?: string
  documentName?: string
}>()
const emit = defineEmits<{
  created: [folder: FileFolder]
  moved: [documentId: string, folderId: string]
  complete: [message: string]
  close: []
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const submitButton = ref<HTMLButtonElement | null>(null)
const name = ref('')
const error = ref('')
const saving = ref(false)
const createdFolder = ref<FileFolder | null>(null)
const title = computed(() => props.documentId ? '新建文件夹并移入' : '新建文件夹')

function close() {
  if (saving.value) return
  dialog.value?.close()
  emit('close')
}
function onKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault()
}
async function submit() {
  if (saving.value) return
  error.value = ''
  const trimmed = name.value.trim()
  if (!createdFolder.value && (!trimmed || trimmed.length > 100 || /[\\/\u0000-\u001f\u007f]/.test(trimmed))) {
    error.value = '请输入 1–100 个字符的文件夹名称，不能包含斜线或控制字符。'
    nameInput.value?.focus()
    return
  }
  saving.value = true
  try {
    if (!createdFolder.value) {
      createdFolder.value = await api.createFolder(trimmed, props.parentId)
      emit('created', createdFolder.value)
    }
    if (props.documentId) {
      await api.moveDocument(props.documentId, createdFolder.value.id)
      emit('moved', props.documentId, createdFolder.value.id)
    }
    emit('complete', props.documentId ? `已创建「${createdFolder.value.name}」并移入文件` : `已创建「${createdFolder.value.name}」`)
    dialog.value?.close()
    emit('close')
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : '本地服务暂时无法完成请求。'
    error.value = createdFolder.value ? `文件夹已创建，但文件移动失败：${reason} 可重试移动，或取消后稍后移动。` : reason
  } finally {
    saving.value = false
    await nextTick()
    if (error.value) (createdFolder.value ? submitButton.value : nameInput.value)?.focus()
  }
}

onMounted(() => {
  dialog.value?.showModal()
  nameInput.value?.focus()
})
</script>

<template>
  <dialog ref="dialog" class="folder-dialog" aria-labelledby="folder-dialog-title" aria-describedby="folder-location" @cancel.prevent="close" @keydown="onKeydown">
    <form novalidate :aria-busy="saving" @submit.prevent="submit">
      <h2 id="folder-dialog-title">{{ title }}</h2>
      <p id="folder-location" class="folder-context">创建位置：{{ parentPath }}</p>
      <p v-if="documentId" class="folder-context">创建后移入：{{ documentName }}</p>
      <label for="folder-name">文件夹名称</label>
      <input id="folder-name" ref="nameInput" v-model="name" type="text" maxlength="100" autocomplete="off" :disabled="saving || Boolean(createdFolder)" :aria-invalid="Boolean(error)" :aria-describedby="error ? 'folder-name-error' : undefined" @input="error = ''" />
      <p v-if="error" id="folder-name-error" class="folder-error" role="alert">{{ error }}</p>
      <div class="folder-actions">
        <button type="button" class="secondary-button" :disabled="saving" @click="close">取消</button>
        <button ref="submitButton" type="submit" class="primary-button" :disabled="saving">{{ saving ? (createdFolder ? '正在移动…' : '正在创建…') : createdFolder ? '重试移动' : documentId ? '创建并移入' : '创建' }}</button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.folder-dialog { width: min(440px, calc(100vw - var(--space-6))); max-height: calc(100dvh - var(--space-6)); margin: auto; padding: var(--space-5); overflow: auto; border: 0; border-radius: var(--radius-md); color: var(--ink); background: var(--surface); }
.folder-dialog::backdrop { background: var(--drawer-scrim); }
form { display: grid; gap: var(--space-3); }
h2 { margin: 0 0 var(--space-1); font-size: var(--text-lg); }
.folder-context { margin: 0; color: var(--muted); font-size: var(--text-sm); line-height: 1.7; overflow-wrap: anywhere; }
label { margin-top: var(--space-2); font-size: var(--text-sm); font-weight: 650; }
input { width: 100%; min-width: 0; min-height: 40px; padding: var(--space-2) var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink); background: var(--surface); }
input:hover:not(:disabled) { border-color: var(--quiet); }
input:disabled { color: var(--quiet); background: var(--surface-soft); cursor: not-allowed; }
input[aria-invalid="true"] { border-color: var(--danger); }
.folder-error { margin: 0; color: var(--danger); font-size: var(--text-sm); line-height: 1.7; overflow-wrap: anywhere; }
.folder-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
.primary-button { color: var(--surface); background: var(--accent-strong); }
.primary-button:hover:not(:disabled) { background: var(--button-hover); }
.primary-button:disabled { color: var(--quiet); background: var(--surface-soft); }
</style>
