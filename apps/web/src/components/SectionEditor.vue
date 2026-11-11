<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import type { ContentBlock, Section } from '../api'

const props = defineProps<{ section: Section; sections: Section[]; blocks: ContentBlock[]; busy: boolean }>()
const emit = defineEmits<{ close: []; save: [edit: Record<string, unknown>] }>()
const operation = ref<'rename' | 'move' | 'merge' | 'split'>('rename')
const title = ref('')
const targetId = ref('')
const blockId = ref('')
const newTitle = ref('')
const excludedIds = computed(() => {
  const result = new Set([props.section.id])
  const visit = (id: string) => {
    for (const section of props.sections.filter(item => item.parentId === id)) {
      if (result.has(section.id)) continue
      result.add(section.id)
      visit(section.id)
    }
  }
  visit(props.section.id)
  return result
})
const targets = computed(() => props.sections.filter(item => !excludedIds.value.has(item.id)))
const splitBlocks = computed(() => props.blocks.filter(item => item.sectionId === props.section.id).slice(1))
const valid = computed(() => operation.value === 'rename' ? Boolean(title.value.trim()) : operation.value === 'merge' ? Boolean(targetId.value) : operation.value === 'split' ? Boolean(blockId.value && newTitle.value.trim()) : true)
watch(() => props.section, value => { title.value = value.title; targetId.value = value.parentId ?? ''; operation.value = 'rename' }, { immediate: true })
watch(operation, value => { targetId.value = value === 'move' ? props.section.parentId ?? '' : ''; blockId.value = splitBlocks.value[0]?.id ?? ''; newTitle.value = '' })
function submit() {
  if (!valid.value || props.busy) return
  const edit: Record<string, unknown> = { operation: operation.value, sectionId: props.section.id }
  if (operation.value === 'rename') edit.title = title.value.trim()
  if (operation.value === 'move') { edit.parentSectionId = targetId.value || null; edit.displayOrder = props.sections.filter(item => (item.parentId ?? '') === targetId.value).length }
  if (operation.value === 'merge') edit.targetSectionId = targetId.value
  if (operation.value === 'split') { edit.blockId = blockId.value; edit.splitOffset = 0; edit.newTitle = newTitle.value.trim() }
  emit('save', edit)
}
function preview(block: ContentBlock) { return (block.plainText || block.text || block.type).replace(/\s+/g, ' ').slice(0, 72) }
</script>

<template>
  <section class="section-editor" role="dialog" aria-modal="true" aria-labelledby="section-editor-title">
    <div class="settings-header"><h2 id="section-editor-title">调整章节</h2><button class="icon-button" aria-label="关闭章节编辑" @click="emit('close')"><X :size="18" /></button></div>
    <p class="section-edit-context">{{ section.title }}</p>
    <form class="settings-form" @submit.prevent="submit">
      <label>调整方式<select v-model="operation"><option value="rename">修改标题</option><option value="move">移动到其他章节</option><option value="split">在内容块前拆分</option><option value="merge">合并到其他章节</option></select></label>
      <label v-if="operation === 'rename'">章节标题<input v-model="title" maxlength="240" autofocus /></label>
      <label v-if="operation === 'move' || operation === 'merge'">{{ operation === 'move' ? '父章节' : '合并目标' }}<select v-model="targetId"><option v-if="operation === 'move'" value="">文档根目录</option><option v-else value="" disabled>选择目标章节</option><option v-for="target in targets" :key="target.id" :value="target.id">{{ target.title }}</option></select></label>
      <template v-if="operation === 'split'">
        <label>新章节起始内容<select v-model="blockId"><option v-for="block in splitBlocks" :key="block.id" :value="block.id">{{ preview(block) }}</option></select></label>
        <label>新章节标题<input v-model="newTitle" maxlength="240" /></label>
        <p class="form-help">从所选内容块前拆分，原文和引用定位保持可用。</p>
        <p v-if="!splitBlocks.length" class="form-help">此章节需要至少两个内容块才能拆分。</p>
      </template>
      <p v-if="operation === 'merge'" class="form-help">当前章节的内容和子章节将归入所选章节。</p>
      <button class="primary-button save-settings" :disabled="busy || !valid">{{ busy ? '正在保存' : '保存调整' }}</button>
    </form>
  </section>
</template>
