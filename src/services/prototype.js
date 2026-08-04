/**
 * prototype — PRD 阶段 HTML 原型生成与本地持久化（t5）
 *
 * 流程：取当前 PRD 交付物内容 → LLM 生成单文件 HTML 原型（线框风格）
 *       → Tauri fs 命令保存到 {appDataDir}/prototypes/{projectId}/{deliveryId}.html
 *       → 页面内 iframe 预览。
 *
 * prompt key 为 `prototype`（ai.js / sidecar llm.ts GENERATION_PROMPTS）。
 */

import { invoke } from '@tauri-apps/api/core'
import { appDataDir, join as pathJoin } from '@tauri-apps/api/path'
import { generateDeliverable } from './ai'

/** Strip markdown code fences the model may wrap around the HTML. */
export function extractHtml(raw) {
  if (!raw || typeof raw !== 'string') return ''
  const fenced = raw.match(/```(?:html)?\s*\n?([\s\S]*?)```/i)
  const html = (fenced ? fenced[1] : raw).trim()
  return html
}

/** Local persistence path: {appDataDir}/prototypes/{projectId}/{deliveryId}.html */
export async function getPrototypePath(projectId, deliveryId) {
  const base = await appDataDir()
  return pathJoin(base, 'prototypes', projectId, `${deliveryId}.html`)
}

/** Save generated HTML (overwrite on regeneration). Returns the saved path. */
export async function savePrototype(projectId, deliveryId, html) {
  const path = await getPrototypePath(projectId, deliveryId)
  await invoke('fs_write_file', { path, contents: html })
  return path
}

/** Load a previously saved prototype; null when not generated yet. */
export async function loadPrototype(projectId, deliveryId) {
  try {
    const path = await getPrototypePath(projectId, deliveryId)
    const html = await invoke('fs_read_file', { path })
    return html || null
  } catch {
    return null
  }
}

/**
 * Generate prototype HTML from PRD content.
 * PRD 内容作为 previousContent 传入，复用 generateDeliverable 的模型/配置链路。
 */
export async function generatePrototype(prdContent, projectName, requirement, modelOverride = null) {
  const raw = await generateDeliverable('prototype', projectName, requirement, prdContent, modelOverride)
  const html = extractHtml(raw)
  if (!html || !/<html|<!doctype/i.test(html)) {
    throw new Error('模型未返回有效的 HTML 原型，请重试')
  }
  return html
}
