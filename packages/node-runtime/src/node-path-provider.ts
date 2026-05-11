/**
 * PathProvider 的 Node.js 独立实现
 *
 * 为 CLI / npm 服务版提供路径管理，不依赖 Electron。
 *
 * 数据目录来源（优先级从高到低）：
 * 1. 构造函数传入的 dataDir 参数
 * 2. CHATLAB_DATA_DIR 环境变量
 * 3. 默认路径 ~/.chatlab/data/
 *
 * 子目录结构与 Electron 版保持一致。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { PathProvider } from '@openchatlab/core'

export class NodePathProvider implements PathProvider {
  private dataDir: string

  constructor(dataDir?: string) {
    this.dataDir = dataDir || resolveDataDir()
  }

  getDataDir(): string {
    return this.dataDir
  }

  getDatabaseDir(): string {
    return path.join(this.dataDir, 'databases')
  }

  getAiDataDir(): string {
    return path.join(this.dataDir, 'ai')
  }

  getSettingsDir(): string {
    return path.join(this.dataDir, 'settings')
  }

  getCacheDir(): string {
    return path.join(this.dataDir, 'cache')
  }

  getTempDir(): string {
    return path.join(this.dataDir, 'temp')
  }

  getLogsDir(): string {
    return path.join(this.dataDir, 'logs')
  }

  getDownloadsDir(): string {
    return path.join(os.homedir(), 'Downloads')
  }

  /**
   * 确保所有子目录存在
   */
  ensureAllDirs(): void {
    const dirs = [
      this.dataDir,
      this.getDatabaseDir(),
      this.getAiDataDir(),
      this.getSettingsDir(),
      this.getCacheDir(),
      this.getTempDir(),
      this.getLogsDir(),
    ]
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
  }
}

/**
 * 解析数据目录路径
 */
function resolveDataDir(): string {
  const envDir = process.env.CHATLAB_DATA_DIR
  if (envDir) {
    return expandHome(envDir)
  }
  return path.join(os.homedir(), '.chatlab', 'data')
}

/**
 * 展开路径中的 ~ 为用户主目录
 */
function expandHome(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1))
  }
  return filePath
}
