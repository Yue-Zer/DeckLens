<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Check, CircleAlert, CircleCheck, LoaderCircle, Plus, Settings2, Trash2, X } from '@lucide/vue'
import { api, type ProviderKind, type ProviderProfile, type ProviderProfileInput, type ProviderProtocol } from '../api'

const emit = defineEmits<{ close: [] }>()

type Template = {
  name: string
  providerKind: ProviderKind
  protocol: ProviderProtocol
  baseUrl: string
  supportsStreaming: boolean
  supportsVision: boolean
}

const templates: Record<'openai' | 'deepseek' | 'ollama', Template> = {
  openai: { name: 'OpenAI 兼容服务', providerKind: 'openai-compatible', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1', supportsStreaming: true, supportsVision: false },
  deepseek: { name: 'DeepSeek 官方', providerKind: 'deepseek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com', supportsStreaming: true, supportsVision: false },
  ollama: { name: 'Ollama 本地', providerKind: 'ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1:11434', supportsStreaming: true, supportsVision: false },
}

const profiles = ref<ProviderProfile[]>([])
const activeId = ref<string | null>(null)
const selectedId = ref('')
const draft = ref<ProviderProfileInput>(emptyDraft())
const apiKey = ref('')
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const actionError = ref('')
const actionNotice = ref('')
const loadError = ref('')
const dialog = ref<HTMLElement | null>(null)
const selectedProfile = computed(() => profiles.value.find(profile => profile.id === selectedId.value) ?? null)
const timeoutSeconds = computed({
  get: () => Math.round((draft.value.timeoutMs || 60000) / 1000),
  set: (seconds: number) => { draft.value.timeoutMs = Math.round(seconds * 1000) },
})
const keyConfigured = computed(() => Boolean(draft.value.id && selectedProfile.value?.hasApiKey))
const isReservedProtocol = computed(() => draft.value.protocol === 'anthropic-messages')
const busy = computed(() => saving.value || testing.value)

function emptyDraft(template: Template = templates.openai): ProviderProfileInput {
  return {
    name: template.name,
    providerKind: template.providerKind,
    protocol: template.protocol,
    baseUrl: template.baseUrl,
    model: '',
    timeoutMs: 60000,
    supportsStreaming: template.supportsStreaming,
    supportsVision: template.supportsVision,
  }
}

function useTemplate(key: keyof typeof templates) {
  draft.value = emptyDraft(templates[key])
  selectedId.value = ''
  apiKey.value = ''
  actionError.value = ''
  actionNotice.value = ''
}

function selectProfile(profile: ProviderProfile) {
  selectedId.value = profile.id
  draft.value = {
    id: profile.id,
    name: profile.name,
    providerKind: profile.providerKind,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    supportsStreaming: profile.supportsStreaming,
    supportsVision: profile.supportsVision,
  }
  apiKey.value = ''
  actionError.value = ''
  actionNotice.value = ''
}

async function loadProfiles(keepSelected = true) {
  loading.value = true
  loadError.value = ''
  try {
    const result = await api.listProviderProfiles()
    profiles.value = result.profiles
    activeId.value = result.activeId
    const next = keepSelected ? result.profiles.find(item => item.id === selectedId.value) : undefined
    const preferred = next ?? result.profiles.find(item => item.id === result.activeId) ?? result.profiles[0]
    if (preferred) selectProfile(preferred)
    else if (!draft.value.id) useTemplate('openai')
  } catch (error) {
    loadError.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

function changeKind(value: ProviderKind) {
  draft.value.providerKind = value
  if (value === 'deepseek') {
    draft.value.protocol = 'openai-chat'
    draft.value.baseUrl = templates.deepseek.baseUrl
  } else if (value === 'ollama') {
    draft.value.protocol = 'ollama-chat'
    if (!draft.value.baseUrl || draft.value.baseUrl === templates.openai.baseUrl || draft.value.baseUrl === templates.deepseek.baseUrl) draft.value.baseUrl = templates.ollama.baseUrl
  } else if (value === 'anthropic') {
    draft.value.protocol = 'anthropic-messages'
  } else if (draft.value.protocol !== 'openai-chat') {
    draft.value.protocol = 'openai-chat'
  }
}

function changeProtocol(value: ProviderProtocol) {
  draft.value.protocol = value
  if (value === 'ollama-chat') {
    draft.value.providerKind = 'ollama'
    if (!draft.value.baseUrl || draft.value.baseUrl === templates.openai.baseUrl || draft.value.baseUrl === templates.deepseek.baseUrl) draft.value.baseUrl = templates.ollama.baseUrl
  } else if (value === 'anthropic-messages') {
    draft.value.providerKind = 'anthropic'
  } else if (draft.value.providerKind === 'ollama' || draft.value.providerKind === 'anthropic') {
    draft.value.providerKind = 'custom'
  }
}

function profilePayload(activate = false): ProviderProfileInput {
  const value = { ...draft.value, activate }
  const secret = apiKey.value.trim()
  if (secret) value.apiKey = secret
  else delete value.apiKey
  return value
}

async function saveProfile(activate = false) {
  if (!draft.value.name.trim() || !draft.value.model.trim() || !draft.value.baseUrl.trim()) {
    actionError.value = '请填写配置名称、Base URL 和模型名称。'
    return null
  }
  saving.value = true
  actionError.value = ''
  actionNotice.value = ''
  try {
    const saved = await api.saveProviderProfile(profilePayload(activate))
    apiKey.value = ''
    selectedId.value = saved.id
    await loadProfiles()
    actionNotice.value = activate ? '配置已保存并启用。' : '配置已保存。'
    return saved
  } catch (error) {
    actionError.value = errorMessage(error)
    return null
  } finally {
    saving.value = false
  }
}

async function save() {
  await saveProfile(false)
}

async function activate() {
  const saved = await saveProfile(false)
  if (!saved) return
  saving.value = true
  actionError.value = ''
  try {
    await api.activateProviderProfile(saved.id)
    await loadProfiles()
    actionNotice.value = '当前模型已切换。'
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

async function testConnection() {
  const saved = await saveProfile(false)
  if (!saved) return
  testing.value = true
  actionError.value = ''
  actionNotice.value = ''
  try {
    const result = await api.testProviderProfile(saved.id)
    actionNotice.value = `${result.message} (${result.model})`
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    testing.value = false
  }
}

async function removeProfile() {
  if (!draft.value.id || !window.confirm('删除此模型配置及其本机密钥？')) return
  saving.value = true
  actionError.value = ''
  try {
    await api.deleteProviderProfile(draft.value.id)
    apiKey.value = ''
    selectedId.value = ''
    await loadProfiles(false)
    actionNotice.value = '模型配置已删除。'
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

async function clearKey() {
  if (!draft.value.id || !keyConfigured.value || !window.confirm('清除这份配置保存在本机的 API Key？')) return
  saving.value = true
  actionError.value = ''
  try {
    await api.clearProviderApiKey(draft.value.id)
    await loadProfiles()
    actionNotice.value = '本机 API Key 已清除。'
  } catch (error) {
    actionError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : '本地服务暂时无法完成请求。' }
function providerLabel(kind: ProviderKind): string {
  return ({
    'openai-compatible': 'OpenAI 兼容',
    deepseek: 'DeepSeek',
    ollama: 'Ollama',
    anthropic: 'Anthropic',
    custom: '自定义',
  })[kind]
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && !busy.value) emit('close')
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await loadProfiles(false)
  dialog.value?.querySelector<HTMLElement>('button, input, select')?.focus()
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="settings-scrim" @click.self="!busy && emit('close')">
    <section ref="dialog" class="provider-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-dialog-title">
      <header class="provider-dialog-header">
        <div class="provider-dialog-title"><Settings2 :size="19" /><div><p class="eyebrow">LOCAL MODEL ROUTING</p><h2 id="provider-dialog-title">模型供应商</h2></div></div>
        <button class="icon-button" aria-label="关闭模型设置" :disabled="busy" @click="emit('close')"><X :size="18" /></button>
      </header>

      <div class="provider-template-row" aria-label="新建配置模板">
        <span>新建模板</span>
        <button type="button" @click="useTemplate('openai')"><Plus :size="14" />OpenAI 兼容</button>
        <button type="button" @click="useTemplate('deepseek')"><Plus :size="14" />DeepSeek 官方</button>
        <button type="button" @click="useTemplate('ollama')"><Plus :size="14" />Ollama 本地</button>
      </div>

      <div class="provider-dialog-body">
        <aside class="provider-list" aria-label="已保存的供应商配置">
          <div class="provider-list-heading"><strong>已保存</strong><span>{{ profiles.length }}</span></div>
          <div v-if="loading" class="provider-state"><LoaderCircle :size="17" class="spin" />正在读取配置…</div>
          <div v-else-if="loadError" class="provider-state provider-state-error" role="alert"><CircleAlert :size="17" /><span>{{ loadError }}</span><button class="secondary-button" @click="loadProfiles()">重试</button></div>
          <button v-for="profile in profiles" v-else :key="profile.id" class="provider-row" :class="{ selected: profile.id === selectedId }" @click="selectProfile(profile)">
            <span class="provider-row-mark"><Check v-if="profile.active" :size="14" /></span>
            <span class="provider-row-copy"><strong>{{ profile.name }}</strong><small>{{ providerLabel(profile.providerKind) }} · {{ profile.model || '未设置模型' }}</small></span>
            <span v-if="profile.active" class="provider-active-label">当前</span>
          </button>
          <p v-if="!loading && !loadError && !profiles.length" class="provider-empty">还没有已保存的配置。选择上方模板开始添加。</p>
        </aside>

        <form class="provider-form" @submit.prevent="save">
          <div class="provider-form-heading"><div><h3>{{ draft.id ? '编辑配置' : '添加配置' }}</h3><p>密钥仅保存在本机数据目录，不会从服务端读回。</p></div><span v-if="draft.id && selectedProfile?.active" class="current-provider-label"><Check :size="13" />当前使用</span></div>

          <div class="provider-form-grid">
            <label class="settings-field"><span>配置名称</span><input v-model="draft.name" maxlength="100" required autocomplete="off" placeholder="例如：学习模型" /></label>
            <label class="settings-field"><span>供应商模板</span><select :value="draft.providerKind" @change="changeKind(($event.target as HTMLSelectElement).value as ProviderKind)"><option value="openai-compatible">OpenAI 兼容</option><option value="deepseek">DeepSeek 官方</option><option value="ollama">Ollama 本地</option><option value="custom">自定义兼容服务</option><option value="anthropic">Anthropic（协议预留）</option></select></label>
            <label class="settings-field field-wide"><span>Base URL</span><input v-model="draft.baseUrl" type="url" maxlength="2000" required autocomplete="url" spellcheck="false" placeholder="https://api.example.com/v1" /></label>
            <label class="settings-field"><span>模型名称</span><input v-model="draft.model" maxlength="300" required autocomplete="off" placeholder="填写供应商提供的模型 ID" /></label>
            <label class="settings-field"><span>请求超时（秒）</span><input v-model.number="timeoutSeconds" type="number" min="1" max="600" step="1" required /></label>
            <label v-if="draft.protocol !== 'anthropic-messages'" class="settings-field field-wide"><span>接口协议</span><select :value="draft.protocol" @change="changeProtocol(($event.target as HTMLSelectElement).value as ProviderProtocol)"><option value="openai-chat">OpenAI Chat Completions 兼容</option><option value="ollama-chat">Ollama Chat</option><option value="anthropic-messages">Anthropic Messages（预留，暂不可调用）</option></select></label>
            <div v-else class="protocol-notice field-wide"><CircleAlert :size="16" /><span>Anthropic Messages 适配器已预留，当前版本尚未接入；连接测试和调用会明确提示此协议暂不可用。</span></div>
            <label class="settings-field field-wide api-key-field"><span>API Key <small>{{ keyConfigured ? '已配置，留空可保留现有密钥' : '不适用于 Ollama；其他供应商请填写' }}</small></span><input v-model="apiKey" type="password" maxlength="1000" autocomplete="new-password" spellcheck="false" placeholder="仅在本次保存时发送到本机服务" /></label>
          </div>

          <div class="provider-capabilities">
            <label class="settings-toggle"><input v-model="draft.supportsStreaming" type="checkbox" /><span><strong>流式输出</strong><small>按供应商与模型能力开启</small></span></label>
            <label class="settings-toggle"><input v-model="draft.supportsVision" type="checkbox" /><span><strong>视觉输入</strong><small>开启前确认模型接受图片</small></span></label>
          </div>
          <p v-if="draft.supportsVision" class="capability-warning">视觉请求会携带图片内容；不支持图片的模型会在发送前被拦截。</p>

          <div v-if="actionError" class="settings-feedback error" role="alert"><CircleAlert :size="16" /><span>{{ actionError }}</span></div>
          <div v-if="actionNotice" class="settings-feedback success" role="status"><CircleCheck :size="16" /><span>{{ actionNotice }}</span></div>
          <div v-if="isReservedProtocol" class="settings-feedback error" role="status"><CircleAlert :size="16" /><span>该协议目前只保留适配位置，不能进行连接测试或模型调用。</span></div>

          <footer class="provider-form-actions">
            <div class="provider-danger-actions">
              <button v-if="keyConfigured" type="button" class="text-action" :disabled="busy" @click="clearKey">清除 Key</button>
              <button v-if="draft.id" type="button" class="icon-button danger-icon" aria-label="删除配置" title="删除配置" :disabled="busy" @click="removeProfile"><Trash2 :size="16" /></button>
            </div>
            <div class="provider-primary-actions">
              <button type="button" class="secondary-button" :disabled="busy || isReservedProtocol" @click="testConnection"><LoaderCircle v-if="testing" :size="15" class="spin" /><span>{{ testing ? '测试中…' : '测试连接' }}</span></button>
              <button v-if="draft.id && !selectedProfile?.active" type="button" class="secondary-button" :disabled="busy" @click="activate">设为当前</button>
              <button type="submit" class="primary-button" :disabled="busy"><LoaderCircle v-if="saving" :size="15" class="spin" /><span>{{ saving ? '保存中…' : '保存配置' }}</span></button>
            </div>
          </footer>
        </form>
      </div>
    </section>
  </div>
</template>
