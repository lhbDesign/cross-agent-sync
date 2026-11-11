'use strict'
/**
 * electron-builder afterPack 钩子：
 *   - macOS：在**生成 DMG 之前**给 .app 补 ad-hoc 签名（必须在打包阶段，事后再签无效）。
 *   - Windows：macOS 上没有 wine，electron-builder 的 rcedit 跑不了，
 *     所以关闭 signAndEditExecutable，用纯 JS 的 resedit 补图标与版本信息。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function signMac(appOutDir, productFilename) {
  const appPath = path.join(appOutDir, `${productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' })
  console.log(`[afterPack] ad-hoc signed: ${appPath}`)
}

function patchWindowsExe(appOutDir, productFilename, version, iconPath) {
  const ResEdit = require('resedit')
  const PELib = require('pe-library')

  const exePath = path.join(appOutDir, `${productFilename}.exe`)
  if (!fs.existsSync(exePath)) {
    console.log(`[afterPack] 跳过（找不到 ${exePath}）`)
    return
  }

  const exe = PELib.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const res = PELib.NtExecutableResource.from(exe)

  if (fs.existsSync(iconPath)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath))
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      iconFile.icons.map((i) => i.data),
    )
  }

  const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
  if (vis.length) {
    const vi = vis[0]
    const lang = vi.getAvailableLanguages()[0] || { lang: 1033, codepage: 1200 }
    const v = String(version || '1.0.0').split('.').map((n) => Number(n) || 0)
    vi.setFileVersion(`${v[0]}.${v[1]}.${v[2]}.0`, lang.lang)
    vi.setProductVersion(`${v[0]}.${v[1]}.${v[2]}`, lang.lang)
    vi.setStringValues(lang, {
      FileDescription: '跨 Agent 会话同步',
      ProductName: 'Agent Session Sync',
      CompanyName: 'lihaibo',
      LegalCopyright: 'MIT',
      OriginalFilename: `${productFilename}.exe`,
      InternalName: productFilename,
      FileVersion: `${v[0]}.${v[1]}.${v[2]}.0`,
      ProductVersion: `${v[0]}.${v[1]}.${v[2]}`,
    })
    vi.outputToResourceEntries(res.entries)
  }

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
  console.log(`[afterPack] Windows exe 图标/版本已写入: ${exePath}`)
}

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context
  const product = packager.appInfo.productFilename

  if (electronPlatformName === 'darwin') {
    signMac(appOutDir, product)
    return
  }

  if (electronPlatformName === 'win32') {
    patchWindowsExe(appOutDir, product, packager.appInfo.version, path.join(__dirname, '..', 'assets', 'icon.ico'))
  }
}
