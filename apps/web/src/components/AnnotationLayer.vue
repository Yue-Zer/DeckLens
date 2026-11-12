<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, type AnnotationRecord, type AnnotationTarget, type AnnotationTool, type ContentBlock } from '../api'

type Point = { x: number; y: number }
type Rect = { left: number; top: number; width: number; height: number }
type DrawnPath = { blockId: string; points: Point[] }
type SelectionPayload = {
  annotationId: string
  blockIds: string[]
  selectedText: string
  imageRefs: Array<{ blockId: string; assetId: string }>
  imageRegions: Array<{ blockId: string; points: Point[] }>
  clientX: number
  clientY: number
}

const props = defineProps<{
  documentId: string
  versionId: string
  blocks: ContentBlock[]
  tool: AnnotationTool
  highlightAnnotationId: string
  surface?: 'source' | 'article'
  articleRevision?: string
}>()
const emit = defineEmits<{
  selected: [selection: SelectionPayload]
  notice: [message: string]
  error: [message: string]
}>()

const layer = ref<SVGSVGElement | null>(null)
const annotations = ref<AnnotationRecord[]>([])
const svgSize = ref({ width: 0, height: 0 })
const layoutRevision = ref(0)
const lassoPoints = ref<Point[]>([])
const strokeSegments = ref<DrawnPath[]>([])
const saving = ref(false)
let article: HTMLElement | null = null
let resizeObserver: ResizeObserver | null = null
let blockElements = new Map<string, HTMLElement>()
let blockRects = new Map<string, Rect>()
let animationFrame = 0
let activePointerId: number | null = null
let erasing = false

const renderedTargets = computed(() => {
  layoutRevision.value
  return annotations.value.flatMap(annotation => annotation.targets.map((target, index) => ({
    annotationId: annotation.id,
    tool: annotation.tool,
    target,
    index,
    path: pathFor(target),
  })).filter(item => item.path))
})

const livePaths = computed(() => {
  if (props.tool === 'lasso') return lassoPoints.value.length ? [pointsPath(lassoPoints.value, true)] : []
  return strokeSegments.value.map(segment => {
    const target = targetRect(segment.blockId)
    if (!target) return ''
    return pointsPath(segment.points.map(point => ({ x: target.left + point.x * target.width, y: target.top + point.y * target.height })), false)
  }).filter(Boolean)
})

function articleElement() {
  return (layer.value?.parentElement as HTMLElement | null) ?? null
}

const blocksById = computed(() => new Map(props.blocks.map(block => [block.id, block])))

function blockById(blockId: string) {
  return blocksById.value.get(blockId)
}

function blockElement(blockId: string) {
  return blockElements.get(blockId) ?? null
}

function targetRect(blockId: string): Rect | null {
  layoutRevision.value
  return blockRects.get(blockId) ?? null
}

function syncLayout() {
  if (!article) return
  svgSize.value = { width: article.clientWidth, height: article.scrollHeight }
  const rootRect = article.getBoundingClientRect()
  const elements = [...article.querySelectorAll<HTMLElement>('.content-block[data-block-id]')]
  blockElements = new Map(elements.map(element => [element.dataset.blockId!, element]))
  blockRects = new Map()
  for (const block of props.blocks) {
    const element = blockElements.get(block.id)
    const target = block.type === 'image' ? element?.querySelector<HTMLElement>('img') : element
    if (!target) continue
    const rect = target.getBoundingClientRect()
    if (rect.width && rect.height) blockRects.set(block.id, {
      left: rect.left - rootRect.left,
      top: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height,
    })
  }
  layoutRevision.value += 1
}

function scheduleLayout() {
  if (animationFrame) return
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0
    syncLayout()
  })
}

function pointsPath(points: Point[], close: boolean) {
  if (!points.length) return ''
  const value = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
  return close ? `${value} Z` : value
}

function pathFor(target: AnnotationTarget) {
  const rect = targetRect(target.blockId)
  if (!rect) return ''
  const points = target.points.map(point => ({ x: rect.left + point.x * rect.width, y: rect.top + point.y * rect.height }))
  return pointsPath(points, target.shape === 'polygon')
}

function localPoint(event: PointerEvent): Point {
  const rect = article?.getBoundingClientRect()
  return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 }
}

function blockAt(point: Point): { blockId: string; rect: Rect } | null {
  const matches = props.blocks.map(block => ({ blockId: block.id, rect: targetRect(block.id) }))
    .filter((item): item is { blockId: string; rect: Rect } => Boolean(item.rect))
    .filter(item => point.x >= item.rect.left && point.x <= item.rect.left + item.rect.width && point.y >= item.rect.top && point.y <= item.rect.top + item.rect.height)
  return matches.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0] ?? null
}

function normalized(point: Point, rect: Rect): Point {
  return {
    x: Math.min(1, Math.max(0, (point.x - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (point.y - rect.top) / rect.height)),
  }
}

function addStrokePoint(point: Point) {
  const hit = blockAt(point)
  if (!hit) return
  const value = normalized(point, hit.rect)
  let segment = strokeSegments.value.at(-1)
  if (!segment || segment.blockId !== hit.blockId) {
    segment = { blockId: hit.blockId, points: [] }
    strokeSegments.value.push(segment)
  }
  const previous = segment.points.at(-1)
  if (!previous || Math.abs(previous.x - value.x) + Math.abs(previous.y - value.y) > 0.0015) segment.points.push(value)
}

function polygonArea(points: Point[]) {
  return Math.abs(points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length]
    return total + point.x * next.y - next.x * point.y
  }, 0)) / 2
}

function clipPolygon(points: Point[], rect: Rect) {
  let result = points
  const edges: Array<{ inside: (point: Point) => boolean; intersect: (a: Point, b: Point) => Point }> = [
    { inside: point => point.x >= rect.left, intersect: (a, b) => ({ x: rect.left, y: a.y + (b.y - a.y) * (rect.left - a.x) / (b.x - a.x) }) },
    { inside: point => point.x <= rect.left + rect.width, intersect: (a, b) => ({ x: rect.left + rect.width, y: a.y + (b.y - a.y) * (rect.left + rect.width - a.x) / (b.x - a.x) }) },
    { inside: point => point.y >= rect.top, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (rect.top - a.y) / (b.y - a.y), y: rect.top }) },
    { inside: point => point.y <= rect.top + rect.height, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (rect.top + rect.height - a.y) / (b.y - a.y), y: rect.top + rect.height }) },
  ]
  for (const edge of edges) {
    if (!result.length) break
    const input = result
    result = []
    let previous = input.at(-1)!
    for (const current of input) {
      const previousInside = edge.inside(previous)
      const currentInside = edge.inside(current)
      if (currentInside) {
        if (!previousInside) result.push(edge.intersect(previous, current))
        result.push(current)
      } else if (previousInside) result.push(edge.intersect(previous, current))
      previous = current
    }
  }
  return result
}

function blockText(block: ContentBlock) {
  const text = String(block.plainText ?? block.text ?? '')
  if (text.trim()) return text
  const payload = block.payload ?? {}
  if (Array.isArray(payload.items)) return payload.items.map(item => typeof item === 'string' ? item : String((item as Record<string, unknown>)?.text ?? '')).filter(Boolean).join('\n')
  if (Array.isArray(payload.rows)) return payload.rows.map(row => Array.isArray(row) ? row.map(cell => typeof cell === 'string' ? cell : String((cell as Record<string, unknown>)?.text ?? '')).join(' | ') : '').join('\n')
  return String(payload.caption ?? payload.alt ?? '')
}

function blockAssetId(block: ContentBlock) {
  const payload = block.payload ?? {}
  const asset = payload.asset && typeof payload.asset === 'object' ? payload.asset as Record<string, unknown> : {}
  const id = payload.assetId ?? asset.id ?? asset.assetId
  return typeof id === 'string' ? id : ''
}

function selectionText(blockIds: string[]) {
  const chunks: string[] = []
  let length = 0
  for (const id of blockIds) {
    const block = blockById(id)
    if (!block) continue
    const text = blockText(block).trim()
    if (!text) continue
    if (length + text.length > 60000) break
    chunks.push(text)
    length += text.length
  }
  return chunks.join('\n\n')
}

async function loadAnnotations() {
  if (!props.documentId) { annotations.value = []; return }
  const scopeKey = `${props.documentId}:${props.versionId}:${props.surface}:${props.articleRevision}`
  try {
    const result = await api.listAnnotations(props.documentId, { surface: props.surface ?? 'source', articleRevision: props.articleRevision })
    if (scopeKey !== `${props.documentId}:${props.versionId}:${props.surface}:${props.articleRevision}`) return
    annotations.value = result
  }
  catch (error) { emit('error', error instanceof Error ? error.message : '无法读取文档标注。') }
  await nextTick()
  syncLayout()
}

async function saveTargets(tool: 'pen' | 'highlighter' | 'lasso', targets: AnnotationTarget[]) {
  if (!targets.length || !props.documentId) return
  saving.value = true
  try {
    const annotation = await api.createAnnotation({ documentId: props.documentId, tool, targets, surface: props.surface ?? 'source', articleRevision: props.articleRevision })
    annotations.value = [...annotations.value, annotation]
    syncLayout()
    return annotation
  } catch (error) {
    emit('error', error instanceof Error ? error.message : '标注保存失败。')
    return undefined
  } finally { saving.value = false }
}

async function erase(annotationId: string) {
  if (!annotationId) return
  try {
    await api.deleteAnnotation(annotationId)
    annotations.value = annotations.value.filter(annotation => annotation.id !== annotationId)
  } catch (error) { emit('error', error instanceof Error ? error.message : '无法删除该标注。') }
}

function eraseAt(event: PointerEvent) {
  const target = document.elementsFromPoint(event.clientX, event.clientY).find(element => element instanceof SVGElement && element.dataset.annotationId) as SVGElement | undefined
  const annotationId = target?.dataset.annotationId
  if (annotationId) void erase(annotationId)
}

async function finishLasso(point: Point, clientX: number, clientY: number) {
  let polygon = [...lassoPoints.value, point]
  lassoPoints.value = []
  const xs = polygon.map(item => item.x)
  const ys = polygon.map(item => item.y)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  const boundsArea = (right - left) * (bottom - top)
  const area = polygonArea(polygon)
  if (polygon.length < 3 || area < 24 || area / Math.max(boundsArea, 1) < 0.08) {
    if ((right - left) * (bottom - top) < 24) { emit('notice', '圈选区域太小，请围住一段正文或图片。'); return }
    polygon = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
  }
  const targets: AnnotationTarget[] = []
  for (const block of props.blocks) {
    const rect = targetRect(block.id)
    if (!rect) continue
    const clipped = clipPolygon(polygon, rect)
    if (clipped.length < 3 || polygonArea(clipped) < 4) continue
    targets.push({ blockId: block.id, shape: 'polygon', points: clipped.map(value => normalized(value, rect)), strokeRatio: 0.0025 })
  }
  const annotation = await saveTargets('lasso', targets)
  if (!annotation) return
  const blockIds = [...new Set(targets.map(target => target.blockId))]
  const imageTargets = targets.filter(target => blockById(target.blockId)?.type === 'image')
  const imageRefs = imageTargets.map(target => ({ blockId: target.blockId, assetId: blockAssetId(blockById(target.blockId)!) })).filter(item => item.assetId).slice(0, 4)
  emit('selected', {
    annotationId: annotation.id,
    blockIds,
    selectedText: selectionText(blockIds),
    imageRefs,
    imageRegions: imageTargets.map(target => ({ blockId: target.blockId, points: target.points })),
    clientX,
    clientY,
  })
}

function onPointerDown(event: PointerEvent) {
  if (props.tool === 'pointer' || saving.value) return
  if (props.tool === 'eraser') {
    erasing = true
    activePointerId = event.pointerId
    layer.value?.setPointerCapture(event.pointerId)
    eraseAt(event)
    return
  }
  event.preventDefault()
  activePointerId = event.pointerId
  layer.value?.setPointerCapture(event.pointerId)
  const point = localPoint(event)
  if (props.tool === 'lasso') lassoPoints.value = [point]
  else { strokeSegments.value = []; addStrokePoint(point) }
}

function onPointerMove(event: PointerEvent) {
  if (props.tool === 'eraser') {
    if (erasing && event.buttons) eraseAt(event)
    return
  }
  if (activePointerId !== event.pointerId) return
  const point = localPoint(event)
  if (props.tool === 'lasso') lassoPoints.value.push(point)
  else addStrokePoint(point)
}

async function onPointerUp(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return
  activePointerId = null
  if (layer.value?.hasPointerCapture(event.pointerId)) layer.value.releasePointerCapture(event.pointerId)
  if (props.tool === 'eraser') { erasing = false; return }
  const point = localPoint(event)
  if (props.tool === 'lasso') { await finishLasso(point, event.clientX, event.clientY); return }
  const minPoints = props.tool === 'pen' ? 2 : 2
  const targets = strokeSegments.value.filter(segment => segment.points.length >= minPoints).map(segment => ({
    blockId: segment.blockId,
    shape: 'path' as const,
    points: segment.points,
    strokeRatio: props.tool === 'highlighter' ? 0.014 : 0.003,
  }))
  strokeSegments.value = []
  if (props.tool === 'pen' || props.tool === 'highlighter') await saveTargets(props.tool, targets)
}

function onPointerCancel(event: PointerEvent) {
  if (activePointerId !== event.pointerId) return
  activePointerId = null
  erasing = false
  lassoPoints.value = []
  strokeSegments.value = []
}

async function clear() {
  if (!props.documentId) return
  try {
    await api.clearAnnotations(props.documentId, { surface: props.surface ?? 'source', articleRevision: props.articleRevision })
    annotations.value = []
    emit('notice', props.surface === 'article' ? '已清除当前文章版本的标注。' : '已清除当前原文版本的标注。')
  } catch (error) { emit('error', error instanceof Error ? error.message : '无法清除文档标注。') }
}

watch(() => [props.documentId, props.versionId, props.surface, props.articleRevision], () => { annotations.value = []; void loadAnnotations() }, { immediate: true })
watch(() => props.blocks.map(block => `${block.id}:${block.sectionId}`).join('|'), async () => {
  await nextTick()
  syncLayout()
})
watch(() => props.highlightAnnotationId, scheduleLayout)
watch(() => props.tool, () => {
  activePointerId = null
  erasing = false
  lassoPoints.value = []
  strokeSegments.value = []
})

onMounted(async () => {
  article = articleElement()
  if (article && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleLayout)
    resizeObserver.observe(article)
  }
  window.addEventListener('resize', scheduleLayout, { passive: true })
  await nextTick()
  syncLayout()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  blockElements.clear()
  blockRects.clear()
  window.removeEventListener('resize', scheduleLayout)
  if (animationFrame) window.cancelAnimationFrame(animationFrame)
})

defineExpose({ clear, reload: loadAnnotations })
</script>

<template>
  <svg
    ref="layer"
    class="annotation-layer"
    :class="`tool-${tool}`"
    :viewBox="`0 0 ${Math.max(svgSize.width, 1)} ${Math.max(svgSize.height, 1)}`"
    :width="svgSize.width"
    :height="svgSize.height"
    aria-hidden="true"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
  >
    <template v-for="item in renderedTargets" :key="`${item.annotationId}-${item.index}`">
      <path
        :d="item.path"
        class="annotation-mark"
        :class="[`mark-${item.tool}`, { 'is-highlighted': item.annotationId === highlightAnnotationId }]"
        :stroke-width="Math.max(2, item.target.strokeRatio * (targetRect(item.target.blockId)?.width ?? 1))"
        :fill="item.target.shape === 'polygon' ? 'var(--accent-soft)' : 'none'"
        :data-annotation-id="item.annotationId"
      />
      <path
        v-if="tool === 'eraser'"
        :d="item.path"
        class="annotation-hit-target"
        :stroke-width="Math.max(16, item.target.strokeRatio * (targetRect(item.target.blockId)?.width ?? 1) + 12)"
        :data-annotation-id="item.annotationId"
      />
    </template>
    <path v-for="(path, index) in livePaths" :key="`live-${index}`" :d="path" class="annotation-draft" :class="`mark-${tool}`" />
  </svg>
</template>
