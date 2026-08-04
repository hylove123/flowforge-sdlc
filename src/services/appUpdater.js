/**
 * appUpdater — 应用自动更新封装（tauri-plugin-updater）
 *
 * 仅 Tauri 桌面环境可用（浏览器/无 __TAURI_INTERNALS__ 时返回 unsupported）。
 * 更新端点与公钥在 src-tauri/tauri.conf.json → plugins.updater 配置；
 * 产物签名由 tauri build 时的 TAURI_SIGNING_PRIVATE_KEY* 环境变量完成。
 *
 * 典型流程：
 *   const upd = await checkForUpdate()          // { available, version, notes } | null
 *   if (upd) await downloadAndInstall(onProgress) // 下载 → 校验签名 → 安装并重启
 */

import { detectRuntimeMode } from '@/adapters/StorageService'

/** 检查是否有新版本。无新版本返回 null；端点不可达/未配置时抛错（含可读消息）。 */
export async function checkForUpdate() {
  if (detectRuntimeMode() !== 'tauri') return null
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) return null
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date ?? null,
    body: update.body ?? '',
    raw: update,
  }
}

/**
 * 下载并安装更新，完成后自动重启应用。
 * @param {Function} onProgress ({ downloaded, total, percent }) 下载进度回调
 */
export async function downloadAndInstall(onProgress) {
  const { check } = await import('@tauri-apps/plugin-updater')
  const { relaunch } = await import('@tauri-apps/plugin-process')
  const update = await check()
  if (!update) throw new Error('当前已是最新版本')

  let downloaded = 0
  let total = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress?.({ downloaded, total, percent: total ? Math.round((downloaded / total) * 100) : 0 })
    } else if (event.event === 'Finished') {
      onProgress?.({ downloaded, total, percent: 100 })
    }
  })
  // 安装完成 — 重启以启用新版本；若重启被拦截（如旧包 ACL 缺 process 权限），
  // 此时新版本已替换完成，提示用户手动重启即可。
  try {
    await relaunch()
  } catch {
    throw new Error('更新已安装完成，请手动重启 FlowForge 以启用新版本')
  }
}

/** 把 updater 底层错误转为用户可读文案。 */
export function describeUpdateError(e) {
  const msg = e?.message || String(e)
  if (/network|dns|failed to fetch|fetch|ECONN|ENOTFOUND|error sending request/i.test(msg)) {
    return '更新服务暂不可达（端点未配置或网络异常），请稍后重试'
  }
  if (/signature|verify|invalid/i.test(msg)) {
    return '更新包签名校验失败，已中止更新'
  }
  return `检查更新失败：${msg}`
}
