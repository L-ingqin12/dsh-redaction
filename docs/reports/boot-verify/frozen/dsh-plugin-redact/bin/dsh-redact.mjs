#!/usr/bin/env node
/**
 * dsh-redact — 离线 CLI。与 TUI 内的 /redact 命令共用同一个引擎。
 *
 * 适合「会话未运行」时批量处理，或在 DSH 之外做审计。
 * 用法与原 zsplice 一致：
 *   dsh-redact inspect <log> [--frames] [--match-file <f>]
 *   dsh-redact paths   <log> --line <n>
 *   dsh-redact verify  <log>
 *   dsh-redact plan    <log> --plan <plan.json>
 *   dsh-redact apply   <log> --plan <plan.json> [--apply]
 *   dsh-redact cut     <log> --drop <spec> [--renumber] [--apply]
 *   dsh-redact graph   <sessionsRoot>
 */
import { main } from '../lib/engine.mjs'

main()
