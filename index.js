import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const PKG_DIR    = dirname(fileURLToPath(import.meta.url))
const JOBS_FILE  = join(PKG_DIR, 'jobs.json')
const PROJECT_DIR = resolve(PKG_DIR, '..', '..')
const AURORA_DIR  = join(PROJECT_DIR, 'packages', 'aurora')
const FACTS_FILE  = join(AURORA_DIR, 'memory', 'facts.md')

// ── State I/O ─────────────────────────────────────────────────────────────────

function loadJobs() {
  if (!existsSync(JOBS_FILE)) return []
  try { return JSON.parse(readFileSync(JOBS_FILE, 'utf8')) }
  catch { return [] }
}

function saveJobs(jobs) {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), 'utf8')
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// ── Cron matching (mirrors aurora/scheduler.js logic) ─────────────────────────

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function matchesCron(cronStr, now, tickMinutes = 1) {
  if (!cronStr) return false
  const s   = cronStr.trim().toLowerCase()
  const h   = now.getHours()
  const m   = now.getMinutes()
  const dow = now.getDay()
  const tol = Math.max(1, Math.floor(tickMinutes / 2))

  const withinTol = (th, tm) => Math.abs(h * 60 + m - (th * 60 + tm)) <= tol

  const parseHHMM = (str) => {
    const p = str.replace(':', ' ').trim().split(/\s+/)
    if (p.length === 2) return [parseInt(p[0]), parseInt(p[1])]
    if (str.startsWith(':')) return [h, parseInt(str.slice(1))]
    return null
  }

  if (s.startsWith('daily '))    { const t = parseHHMM(s.slice(6));  return t ? withinTol(t[0], t[1]) : false }
  if (s.startsWith('weekly '))   { const p = s.slice(7).trim().split(/\s+/); if (p.length < 2) return false; const d = DOW[p[0]]; if (d === undefined || d !== dow) return false; const t = parseHHMM(p.slice(1).join(':')); return t ? withinTol(t[0], t[1]) : false }
  if (s.startsWith('weekdays ')) { if (dow === 0 || dow === 6) return false; const t = parseHHMM(s.slice(9)); return t ? withinTol(t[0], t[1]) : false }
  if (s.startsWith('weekends ')) { if (dow !== 0 && dow !== 6) return false; const t = parseHHMM(s.slice(9)); return t ? withinTol(t[0], t[1]) : false }
  if (s.startsWith('hourly'))    { const rest = s.slice(6).trim(); return rest.startsWith(':') ? Math.abs(m - parseInt(rest.slice(1))) <= tol : Math.abs(m) <= tol }
  if (s.startsWith('interval ')) { const match = s.match(/interval\s+(\d+)\s*min/); if (!match) return false; const iv = parseInt(match[1]); return iv > 0 && (h * 60 + m) % iv <= tol }

  return false
}

// Formato especial para execução única: "once YYYY-MM-DD HH:MM"
function matchesOnce(cronStr, now) {
  if (!cronStr.startsWith('once ')) return false
  const when = cronStr.slice(5).trim()
  // Espera "YYYY-MM-DD HH:MM"
  const [datePart, timePart] = when.split(' ')
  if (!datePart || !timePart) return false
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  const target = new Date(year, month - 1, day, hour, minute, 0, 0)
  // Executa se dentro da janela de tolerância de 1 minuto (tick a cada 1 min)
  const diffMs = Math.abs(now - target)
  return diffMs <= 60 * 1000 // 1 minuto
}

// ── Migration from facts.md ───────────────────────────────────────────────────

function migrateFromFacts() {
  if (!existsSync(FACTS_FILE)) return []
  const lines = readFileSync(FACTS_FILE, 'utf8').split('\n')
  const migrated = []

  for (const line of lines) {
    if (!line.includes('SCHEDULE |')) continue
    const parts = {}
    line.replace(/SCHEDULE\s*\|/, '').split('|').forEach(seg => {
      const [k, ...v] = seg.split(':')
      if (k) parts[k.trim()] = v.join(':').trim().replace(/^"|"$/g, '')
    })
    if (!parts.cron && !parts.task) continue
    migrated.push({
      id:          uid(),
      cron:        parts.cron ?? '',
      task:        parts.task ?? '',
      channel:     parts.channel ?? 'telegram',
      enabled:     true,
      created_at:  new Date().toISOString(),
      last_run:    null,
      run_count:   0,
      last_error:  null,
      history:     [],
      migrated_from_facts: true,
    })
  }

  if (migrated.length > 0) {
    // Remove SCHEDULE lines from facts.md
    const cleaned = lines.filter(l => !l.includes('SCHEDULE |')).join('\n')
    writeFileSync(FACTS_FILE, cleaned, 'utf8')
    console.log(`[cron-jobs] Migrated ${migrated.length} job(s) from facts.md`)
  }

  return migrated
}

// ── Job runner ────────────────────────────────────────────────────────────────

async function runJob(job) {
  const startedAt = new Date().toISOString()
  try {
    let result
    // Suporte a execução direta via run_runtime_tool se a task for JSON com {tool, args}
    if (job.task.startsWith('{') && job.task.includes('"tool"')) {
      const spec = JSON.parse(job.task)
      if (spec.tool && (spec.args || spec.payload)) {
        const { run_runtime_tool } = await import(join(AURORA_DIR, 'runtime_bridge.js'))
        result = await run_runtime_tool({
          package: spec.package || spec.tool.split('.')[0] || '',
          tool: spec.tool.split('.').slice(1).join('.') || spec.tool,
          args: spec.args || spec.payload
        })
      } else {
        throw new Error('Formato inválido: esperado {tool, args, package?}')
      }
    } else {
      const { runAgent } = await import(join(AURORA_DIR, 'agent.js'))
      result = await runAgent(job.task, 'cron-' + job.id)
    }

    const entry = { ran_at: startedAt, success: true, result: String(result).slice(0, 500) }
    job.last_run    = startedAt
    job.last_error  = null
    job.run_count   = (job.run_count ?? 0) + 1
    job.history     = [entry, ...(job.history ?? [])].slice(0, 10)
    console.log(`[cron-jobs] Job "${job.task.slice(0, 50)}" ran OK`)
    return entry
  } catch (e) {
    const entry = { ran_at: startedAt, success: false, error: e.message }
    job.last_run   = startedAt
    job.last_error = e.message
    job.run_count  = (job.run_count ?? 0) + 1
    job.history    = [entry, ...(job.history ?? [])].slice(0, 10)
    console.warn(`[cron-jobs] Job "${job.task.slice(0, 50)}" failed: ${e.message}`)
    return entry
  }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick() {
  const jobs = loadJobs()
  if (!jobs.length) return

  let { nowInTz } = {}
  try { ({ nowInTz } = await import(join(AURORA_DIR, 'timezone.js'))) } catch {}
  const now = nowInTz ? nowInTz() : new Date()

  const due = jobs.filter(j => j.enabled && (matchesCron(j.cron, now, 1) || matchesOnce(j.cron, now)))
  if (!due.length) return

  // Executa jobs e remove os "once" após a primeira execução
  const toRemove = []
  for (const job of due) {
    await runJob(job)
    if (job.cron.startsWith('once ')) toRemove.push(job.id)
  }

  // Remove jobs únicos executados
  if (toRemove.length) {
    const remaining = jobs.filter(j => !toRemove.includes(j.id))
    saveJobs(remaining)
  } else {
    saveJobs(jobs)
  }
}

// ── Tool: cron_add ────────────────────────────────────────────────────────────

export async function cron_add(payload, context) {
  /**
   * @register_tool cron_add
   * @description Adds a new cron job. Replaces the SCHEDULE | facts.md format.
   * @param {string} cron - Cron expression: "daily HH:MM", "weekly mon HH:MM", "hourly :MM", "interval Xmin", ou "once YYYY-MM-DD HH:MM" para execução única
   * @param {string} task - Task description that Aurora will execute
   * @param {string?} channel - Notification channel (default: telegram)
   */
  if (!payload?.cron || !payload?.task) return { success: false, error: 'cron and task are required' }

  const jobs = loadJobs()
  const job = {
    id:         uid(),
    cron:       payload.cron,
    task:       payload.task,
    channel:    payload.channel ?? 'telegram',
    enabled:    true,
    created_at: new Date().toISOString(),
    last_run:   null,
    run_count:  0,
    last_error: null,
    history:    [],
  }
  jobs.push(job)
  saveJobs(jobs)
  return { success: true, job }
}

// ── Tool: cron_list ───────────────────────────────────────────────────────────

export async function cron_list(payload, context) {
  /**
   * @register_tool cron_list
   * @description Lists all cron jobs with status and last run info.
   */
  const jobs = loadJobs()
  return {
    success: true,
    total: jobs.length,
    jobs: jobs.map(j => ({
      id:        j.id,
      cron:      j.cron,
      task:      j.task.slice(0, 80),
      enabled:   j.enabled,
      run_count: j.run_count,
      last_run:  j.last_run,
      last_error: j.last_error,
    }))
  }
}

// ── Tool: cron_remove ────────────────────────────────────────────────────────

export async function cron_remove(payload, context) {
  /**
   * @register_tool cron_remove
   * @description Removes a cron job by ID.
   * @param {string} id - Job ID
   */
  if (!payload?.id) return { success: false, error: 'id is required' }
  const jobs = loadJobs()
  const idx  = jobs.findIndex(j => j.id === payload.id)
  if (idx === -1) return { success: false, error: `Job "${payload.id}" not found` }
  const [removed] = jobs.splice(idx, 1)
  saveJobs(jobs)
  return { success: true, removed: removed.task }
}

// ── Tool: cron_toggle ────────────────────────────────────────────────────────

export async function cron_toggle(payload, context) {
  /**
   * @register_tool cron_toggle
   * @description Enables or disables a cron job by ID.
   * @param {string} id - Job ID
   * @param {boolean?} enabled - Force state (omit to toggle)
   */
  if (!payload?.id) return { success: false, error: 'id is required' }
  const jobs = loadJobs()
  const job  = jobs.find(j => j.id === payload.id)
  if (!job) return { success: false, error: `Job "${payload.id}" not found` }
  job.enabled = payload.enabled !== undefined ? payload.enabled : !job.enabled
  saveJobs(jobs)
  return { success: true, id: job.id, enabled: job.enabled, task: job.task.slice(0, 80) }
}

// ── Tool: cron_history ───────────────────────────────────────────────────────

export async function cron_history(payload, context) {
  /**
   * @register_tool cron_history
   * @description Returns execution history for a cron job.
   * @param {string} id - Job ID
   */
  if (!payload?.id) return { success: false, error: 'id is required' }
  const jobs = loadJobs()
  const job  = jobs.find(j => j.id === payload.id)
  if (!job) return { success: false, error: `Job "${payload.id}" not found` }
  return { success: true, id: job.id, task: job.task, history: job.history ?? [] }
}

// ── Boot: migrate + start tick ───────────────────────────────────────────────

export async function onBoot(payload, context) {
  /**
   * @register_hook boot
   */
  const existing = loadJobs()
  const migrated = migrateFromFacts()
  if (migrated.length > 0) saveJobs([...existing, ...migrated])

  // Hand off tick to Aurora scheduler
  try {
    const { initScheduler } = await import(join(AURORA_DIR, 'scheduler.js'))
    // Patch: register our tick alongside the proactive tick
    const original = globalThis.__auroraProactiveTick
    if (typeof original === 'function') {
      globalThis.__cronTick = tick
    }
  } catch {}

  // Fallback: self-tick via setInterval (1 min)
  setInterval(async () => {
    try { await tick() } catch (e) { console.warn('[cron-jobs] tick error:', e.message) }
  }, 60 * 1000).unref()

  console.log(`[cron-jobs] ready — ${loadJobs().length} job(s)`)
}
