/**
 * Message query module — Electron Worker adapter
 *
 * Thin wrapper that delegates to shared async query functions from @openchatlab/core.
 * The better-sqlite3 sync calls are wrapped as an AsyncSqlExecutor.
 * FTS search remains Electron-specific (depends on @node-rs/jieba tokenizer).
 */

import { openDatabase, buildTimeFilter, type TimeFilter } from '../core'
import { ensureAvatarColumn } from './basic'
import { hasFtsIndex } from './fts'
import { tokenizeQueryForFts } from '../../nlp/ftsTokenizer'
import {
  FULL_MSG_SELECT,
  FULL_MSG_FROM,
  mapMessageRow,
  type FullMessageRow,
  type MappedMessage,
  type AsyncSqlExecutor,
  fetchMessagesBefore,
  fetchMessagesAfter,
  searchMessagesLikeAsync,
  fetchMessageContext,
  fetchSearchMessageContext,
  fetchAllRecentMessages,
  fetchRecentTextMessages,
  fetchConversationBetween,
} from '@openchatlab/core'

// ==================== Types ====================

export type MessageResult = MappedMessage

export interface PaginatedMessages {
  messages: MessageResult[]
  hasMore: boolean
}

export interface MessagesWithTotal {
  messages: MessageResult[]
  total: number
}

// ==================== Executor adapter ====================

function createSyncExecutor(sessionId: string): AsyncSqlExecutor | null {
  const db = openDatabase(sessionId)
  if (!db) return null
  return {
    all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return Promise.resolve(db.prepare(sql).all(...params) as T[])
    },
    get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      return Promise.resolve(db.prepare(sql).get(...params) as T | undefined)
    },
  }
}

// ==================== Query functions ====================

/**
 * Get recent text-only messages (AI Agent use — excludes system and non-text).
 */
export async function getRecentMessages(
  sessionId: string,
  filter?: TimeFilter,
  limit: number = 100
): Promise<MessagesWithTotal> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return { messages: [], total: 0 }
  return fetchRecentTextMessages(executor, filter, limit)
}

/**
 * Get all recent messages (message viewer — includes all types).
 */
export async function getAllRecentMessages(
  sessionId: string,
  filter?: TimeFilter,
  limit: number = 100
): Promise<MessagesWithTotal> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return { messages: [], total: 0 }
  return fetchAllRecentMessages(executor, filter, limit)
}

/**
 * Keyword search with optional FTS5 acceleration.
 * FTS path remains Electron-specific; LIKE fallback delegates to core.
 */
export async function searchMessages(
  sessionId: string,
  keywords: string[],
  filter?: TimeFilter,
  limit: number = 20,
  offset: number = 0,
  senderId?: number
): Promise<MessagesWithTotal> {
  ensureAvatarColumn(sessionId)

  const db = openDatabase(sessionId)
  if (!db) return { messages: [], total: 0 }

  const useFts = keywords.length > 0 && hasFtsIndex(sessionId)
  let matchQuery = ''
  if (useFts) {
    matchQuery = tokenizeQueryForFts(keywords)
  }

  if (useFts && matchQuery) {
    return searchMessagesWithFts(db, sessionId, matchQuery, filter, limit, offset, senderId)
  }

  const executor = createSyncExecutor(sessionId)!
  return searchMessagesLikeAsync(executor, keywords, filter, limit, offset, senderId)
}

/**
 * FTS5 search path (Electron-specific, depends on platform tokenizer).
 */
function searchMessagesWithFts(
  db: ReturnType<typeof openDatabase> & object,
  _sessionId: string,
  matchQuery: string,
  filter?: TimeFilter,
  limit: number = 20,
  offset: number = 0,
  senderId?: number
): MessagesWithTotal {
  const { clause: timeClause, params: timeParams } = buildTimeFilter(filter, 'msg')
  const timeCondition = timeClause ? timeClause.replace('WHERE', 'AND') : ''

  const senderCondition = senderId !== undefined ? 'AND msg.sender_id = ?' : ''
  const senderParams = senderId !== undefined ? [senderId] : []

  try {
    const countSql = `
      SELECT COUNT(*) as total
      ${FULL_MSG_FROM}
      WHERE msg.id IN (SELECT rowid FROM message_fts WHERE content MATCH ?)
      ${timeCondition}
      ${senderCondition}
    `
    const totalRow = db.prepare(countSql).get(matchQuery, ...timeParams, ...senderParams) as { total: number }
    const total = totalRow?.total || 0

    const sql = `
      ${FULL_MSG_SELECT}
      WHERE msg.id IN (SELECT rowid FROM message_fts WHERE content MATCH ?)
      ${timeCondition}
      ${senderCondition}
      ORDER BY msg.ts DESC
      LIMIT ? OFFSET ?
    `
    const rows = db.prepare(sql).all(matchQuery, ...timeParams, ...senderParams, limit, offset) as FullMessageRow[]

    return { messages: rows.map(mapMessageRow), total }
  } catch (error) {
    console.error('[FTS] searchMessages FTS path failed, falling back to LIKE:', error)
    return searchMessagesWithLike(db, [], filter, limit, offset, senderId)
  }
}

/**
 * LIKE search path (fallback or deep_search).
 * Kept as a synchronous helper for the FTS fallback path.
 */
export function searchMessagesWithLike(
  db: ReturnType<typeof openDatabase> & object,
  keywords: string[],
  filter?: TimeFilter,
  limit: number = 20,
  offset: number = 0,
  senderId?: number
): MessagesWithTotal {
  let keywordCondition = '1=1'
  const keywordParams: string[] = []
  if (keywords.length > 0) {
    keywordCondition = `(${keywords.map(() => `msg.content LIKE ?`).join(' OR ')})`
    keywordParams.push(...keywords.map((k) => `%${k}%`))
  }

  const { clause: timeClause, params: timeParams } = buildTimeFilter(filter, 'msg')
  const timeCondition = timeClause ? timeClause.replace('WHERE', 'AND') : ''

  const senderCondition = senderId !== undefined ? 'AND msg.sender_id = ?' : ''
  const senderParams = senderId !== undefined ? [senderId] : []

  const countSql = `
    SELECT COUNT(*) as total
    ${FULL_MSG_FROM}
    WHERE ${keywordCondition}
    ${timeCondition}
    ${senderCondition}
  `
  const totalRow = db.prepare(countSql).get(...keywordParams, ...timeParams, ...senderParams) as { total: number }
  const total = totalRow?.total || 0

  const sql = `
    ${FULL_MSG_SELECT}
    WHERE ${keywordCondition}
    ${timeCondition}
    ${senderCondition}
    ORDER BY msg.ts DESC
    LIMIT ? OFFSET ?
  `
  const rows = db.prepare(sql).all(...keywordParams, ...timeParams, ...senderParams, limit, offset) as FullMessageRow[]

  return { messages: rows.map(mapMessageRow), total }
}

/**
 * Deep search (always LIKE, no FTS).
 */
export async function deepSearchMessages(
  sessionId: string,
  keywords: string[],
  filter?: TimeFilter,
  limit: number = 20,
  offset: number = 0,
  senderId?: number
): Promise<MessagesWithTotal> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return { messages: [], total: 0 }
  return searchMessagesLikeAsync(executor, keywords, filter, limit, offset, senderId)
}

/**
 * Get message context (surrounding messages by id).
 */
export async function getMessageContext(
  sessionId: string,
  messageIds: number | number[],
  contextSize: number = 20
): Promise<MessageResult[]> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return []
  return fetchMessageContext(executor, messageIds, contextSize)
}

/**
 * Get search message context (session-aware with fallback).
 */
export async function getSearchMessageContext(
  sessionId: string,
  messageIds: number[],
  contextBefore: number = 2,
  contextAfter: number = 2
): Promise<MessageResult[]> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return []
  return fetchSearchMessageContext(executor, messageIds, contextBefore, contextAfter)
}

/**
 * Fetch N messages before a given id (infinite scroll up).
 */
export async function getMessagesBefore(
  sessionId: string,
  beforeId: number,
  limit: number = 50,
  filter?: TimeFilter,
  senderId?: number,
  keywords?: string[]
): Promise<PaginatedMessages> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return { messages: [], hasMore: false }
  return fetchMessagesBefore(executor, beforeId, limit, filter, senderId, keywords)
}

/**
 * Fetch N messages after a given id (infinite scroll down).
 */
export async function getMessagesAfter(
  sessionId: string,
  afterId: number,
  limit: number = 50,
  filter?: TimeFilter,
  senderId?: number,
  keywords?: string[]
): Promise<PaginatedMessages> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return { messages: [], hasMore: false }
  return fetchMessagesAfter(executor, afterId, limit, filter, senderId, keywords)
}

/**
 * Get conversation between two members.
 */
export async function getConversationBetween(
  sessionId: string,
  memberId1: number,
  memberId2: number,
  filter?: TimeFilter,
  limit: number = 100
): Promise<MessagesWithTotal & { member1Name: string; member2Name: string }> {
  ensureAvatarColumn(sessionId)
  const executor = createSyncExecutor(sessionId)
  if (!executor) return { messages: [], total: 0, member1Name: '', member2Name: '' }
  return fetchConversationBetween(executor, memberId1, memberId2, filter, limit)
}
