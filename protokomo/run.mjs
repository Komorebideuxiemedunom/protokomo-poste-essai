// ProtoKomo · poste de travail (GitHub Actions)
//
// Lancé par l'application iPhone ProtoKomo (déclenchement « workflow_dispatch »). Fait tourner le
// vrai Claude Code, non modifié, avec l'abonnement Claude de la personne (secret
// CLAUDE_CODE_OAUTH_TOKEN qu'elle a créé elle-même avec `claude setup-token`), sur une copie de son site :
// mêmes outils, mêmes autorisations et mêmes consignes que ProtoKomo sur ordinateur.
//
// L'avancement est publié dans ce dépôt (branche « etat », un fichier JSON par demande), que l'app lit.
// Les modifications vont sur la branche « protokomo-brouillon » du site ; l'aperçu construit, s'il y en a
// un, sur la branche « apercu/<site> » de ce dépôt. Aucune dépendance : Node et git seulement.

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DRAFT = 'protokomo-brouillon'
const API = process.env.PK_API_URL || 'https://api.github.com'
const GIT_HOST = process.env.PK_GIT_HOST || 'https://github.com'

// ─── Claude Code : réglages identiques à la version bureau (ClaudeCodeProvider) ───────────────────

export const TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'WebFetch']

export const ALLOWED_COMMANDS = [
  'Bash(npm install:*)', 'Bash(npm ci:*)', 'Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npm test:*)', 'Bash(npm ls:*)',
  'Bash(pnpm install:*)', 'Bash(pnpm run build:*)', 'Bash(pnpm build:*)', 'Bash(pnpm lint:*)',
  'Bash(yarn install:*)', 'Bash(yarn build:*)', 'Bash(yarn lint:*)', 'Bash(bun install:*)', 'Bash(bun run build:*)',
  'Bash(npx tsc:*)', 'Bash(npx eslint:*)', 'Bash(npx prettier:*)',
  'Bash(ls:*)', 'Bash(pwd)', 'Bash(wc:*)', 'Bash(file:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)'
]

export const DENIED_COMMANDS = [
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)',
  'Bash(git rebase:*)', 'Bash(git merge:*)', 'Bash(git clean:*)', 'Bash(git stash:*)', 'Bash(git remote:*)',
  'Bash(rm -rf:*)', 'Bash(sudo:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(npm publish:*)', 'Bash(chmod:*)', 'Bash(chown:*)'
]

export const SYSTEM_PROMPT = `Tu es l'assistant intégré à ProtoKomo, un éditeur de sites web pour des personnes qui ne savent pas coder (communication, RH, métiers). La personne te parle depuis son iPhone.

Règles :
- Réponds TOUJOURS en français, avec des phrases simples, sans jargon technique (pas de noms de fichiers, de classes CSS ou de commandes sauf si on te les demande). Décris le résultat visible : « Le bouton Contact est maintenant bleu et plus grand. »
- Avant de modifier quoi que ce soit, inspecte le projet pour trouver précisément les bons fichiers. Ne devine jamais.
- Fais des modifications ciblées et minimales qui respectent le style existant du site. Ne réécris pas des fichiers entiers sans nécessité.
- Ne lance JAMAIS de serveur de développement (npm run dev, npm start…) ni de processus qui ne se termine pas : l'application affiche l'aperçu elle-même.
- N'utilise jamais git pour enregistrer, publier, changer de branche ou annuler : l'application s'en charge. Tu peux lire l'historique (git status, git diff, git log).
- Si la demande est ambiguë, fais le choix le plus raisonnable et explique-le en une phrase, ou pose UNE question courte.
- Si une demande risque de casser le site ou de supprimer beaucoup de contenu, explique le risque et demande confirmation avant d'agir.
- Termine par un résumé très court (1 à 3 phrases) de ce qui a changé visuellement, et suggère éventuellement une prochaine étape.`

export function claudeArgs({ resume }) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    '--tools', TOOLS.join(','),
    '--allowedTools', ...ALLOWED_COMMANDS,
    '--disallowedTools', ...DENIED_COMMANDS,
    // Réglages personnels seulement : jamais ceux du dépôt du site (qui pourraient élargir les droits).
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--append-system-prompt', SYSTEM_PROMPT
  ]
  if (resume) args.push('--continue')
  return args
}

/** Action de Claude en langage courant, comme le fil d'activité de la version bureau. */
export function activityLabel(name, input = {}) {
  const path = input.file_path || input.path || input.notebook_path
  const file = typeof path === 'string' ? path.split('/').pop() : null
  switch (name) {
    case 'Read': return file ? `Lit ${file}` : 'Lit un fichier'
    case 'Write': return file ? `Crée ${file}` : 'Crée un fichier'
    case 'Edit': case 'MultiEdit': return file ? `Modifie ${file}` : 'Modifie un fichier'
    case 'Glob': case 'Grep': return 'Cherche dans le projet'
    case 'WebFetch': return 'Consulte une page web'
    case 'TodoWrite': return 'Organise son travail'
    case 'Bash': {
      const command = String(input.command ?? '')
      if (/\b(install|ci)\b/.test(command)) return 'Installe les dépendances'
      if (/\bbuild\b/.test(command)) return 'Construit le site'
      if (/\b(lint|tsc|eslint|test)\b/.test(command)) return 'Vérifie le site'
      return 'Exécute une commande'
    }
    default: return 'Travaille sur le site'
  }
}

/** Lit une ligne stream-json de Claude Code (même format que claudeStream.ts sur ordinateur). */
export function parseLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return {} }
  if (msg.type === 'rate_limit_event' && msg.rate_limit_info) return { limits: msg.rate_limit_info }
  if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
    const content = Array.isArray(msg.message?.content) ? msg.message.content : []
    return {
      texts: content.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text.trim()),
      tools: content.filter((b) => b.type === 'tool_use' && b.name).map((b) => activityLabel(b.name, b.input))
    }
  }
  if (msg.type === 'result') {
    return { result: { isError: !!msg.is_error || (msg.subtype !== undefined && msg.subtype !== 'success'), text: typeof msg.result === 'string' ? msg.result : '', subtype: msg.subtype ?? null } }
  }
  return {}
}

/** Erreurs de Claude Code traduites (connexion expirée, limites de l'abonnement…). */
export function humanizeClaudeError(text) {
  const t = String(text || '')
  if (/usage limit|rate.?limit|limit reached|5-hour|weekly limit/i.test(t)) return "Limite d'utilisation de votre abonnement Claude atteinte. Réessayez quand elle se renouvelle (l'heure est indiquée sur claude.ai)."
  if (/oauth|401|unauthori[sz]ed|invalid.*token|token.*(expired|invalid)|not logged in|log ?in|authentication/i.test(t)) return 'La connexion à Claude a expiré ou est invalide. Refaites « Connecter Claude » dans ProtoKomo (Réglages → Poste de travail).'
  if (/overloaded|529|503/i.test(t)) return 'Claude est très sollicité en ce moment. Réessayez dans quelques minutes.'
  return t ? `Claude Code s'est arrêté : ${t.slice(0, 300)}` : "Claude Code s'est arrêté sans explication."
}

/** Message de version tiré de la réponse de Claude (première phrase, 72 caractères au plus). */
export function commitMessage(reply) {
  const first = String(reply || '').replace(/[*_`#>]/g, '').split(/(?<=[.!?])\s|\n/).map((s) => s.trim()).find(Boolean)
  if (!first) return 'Modification demandée depuis ProtoKomo'
  return first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first
}

/** Une conversation précédente de ce site est-elle là (dossier restauré par le cache du poste) ? */
export function hasPreviousSession(dir) {
  if (!existsSync(dir)) return false
  const walk = (d) => readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.jsonl')))
  return walk(dir)
}

export function siteSlug(site) {
  return site.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

// ─── Exécution ───────────────────────────────────────────────────────────────────────────────

const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const tryGit = (cwd, args) => { try { return git(cwd, args) } catch { return null } }

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

/** Publie l'état de la demande (fichier etat/<id>.json, branche « etat » de ce dépôt), au plus toutes les 3 s. */
export class StatusPublisher {
  constructor({ token, repo, id, intervalMs = 3000 }) {
    Object.assign(this, { token, repo, id, intervalMs })
    this.state = { id, etat: 'travail', activite: [], reponse: '', erreur: null, apercu: null, apercuErreur: null, commit: null, limites: null, maj: null }
    this.sha = null
    this.last = 0
    this.timer = null
    this.chain = Promise.resolve()
  }

  async ensureBranch() {
    const ref = await api(this.token, 'GET', `/repos/${this.repo}/git/ref/heads/etat`)
    if (ref.status === 200) return
    const repo = await api(this.token, 'GET', `/repos/${this.repo}`)
    const base = await api(this.token, 'GET', `/repos/${this.repo}/git/ref/heads/${repo.json.default_branch}`)
    await api(this.token, 'POST', `/repos/${this.repo}/git/refs`, { ref: 'refs/heads/etat', sha: base.json.object.sha })
  }

  update(patch, { now = false } = {}) {
    Object.assign(this.state, patch)
    if (now) return this.flush()
    if (this.timer) return this.chain
    const wait = Math.max(0, this.intervalMs - (Date.now() - this.last))
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, wait)
    return this.chain
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.chain = this.chain.then(() => this.write()).catch((err) => console.error(`État non publié : ${err.message}`))
    return this.chain
  }

  async write() {
    this.last = Date.now()
    this.state.maj = new Date().toISOString()
    const content = Buffer.from(JSON.stringify(this.state, null, 1)).toString('base64')
    const path = `/repos/${this.repo}/contents/etat/${this.id}.json`
    let res = await api(this.token, 'PUT', path, { message: `État ${this.id}`, content, branch: 'etat', ...(this.sha ? { sha: this.sha } : {}) })
    if (res.status === 409 || res.status === 422) {
      const current = await api(this.token, 'GET', `${path}?ref=etat`)
      this.sha = current.json?.sha ?? null
      res = await api(this.token, 'PUT', path, { message: `État ${this.id}`, content, branch: 'etat', ...(this.sha ? { sha: this.sha } : {}) })
    }
    if (res.status >= 300) throw new Error(`GitHub ${res.status}`)
    this.sha = res.json.content.sha
  }
}

/** Lance Claude Code (binaire officiel, non modifié) et relaie son activité. */
export function runClaude({ cwd, prompt, resume, bin = 'claude', onActivity, onText, onLimits }) {
  return new Promise((resolve) => {
    const child = spawn(bin, claudeArgs({ resume }), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let result = null
    const texts = []
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const parsed = parseLine(line)
        for (const label of parsed.tools ?? []) onActivity?.(label)
        for (const text of parsed.texts ?? []) { texts.push(text); onText?.(text) }
        if (parsed.limits) onLimits?.(parsed.limits)
        if (parsed.result) result = parsed.result
      }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
    child.on('error', (err) => resolve({ ok: false, error: `Claude Code introuvable (${err.message})`, texts }))
    child.on('close', (code) => {
      if (result && !result.isError) return resolve({ ok: true, reply: result.text || texts.at(-1) || '', texts })
      resolve({ ok: false, error: result?.text || stderr || `code ${code}`, texts })
    })
    child.stdin.end(prompt)
  })
}

const OUTPUT_DIRS = ['dist', 'build', 'out', '_site', 'public', 'docs', '.output/public', 'www', 'site']

/** Construit le site s'il le faut et rend le dossier à afficher (null : pas de construction). */
export function buildPreview(siteDir, log = console.log) {
  const pkgFile = join(siteDir, 'package.json')
  if (!existsSync(pkgFile)) return null
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (!pkg.scripts?.build) return null
  const has = (f) => existsSync(join(siteDir, f))
  const [pm, install] = has('pnpm-lock.yaml') ? ['pnpm', ['install', '--frozen-lockfile']]
    : has('yarn.lock') ? ['yarn', ['install', '--frozen-lockfile']]
      : has('bun.lockb') || has('bun.lock') ? ['bun', ['install']]
        : ['npm', has('package-lock.json') ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund']]
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: siteDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, CI: '1' } })
  if (pm === 'pnpm' || pm === 'yarn') run('corepack', ['enable'])
  log(`Installation (${pm})`)
  run(pm, install)
  log('Construction')
  run(pm, ['run', 'build'])
  for (const dir of OUTPUT_DIRS) {
    if (existsSync(join(siteDir, dir, 'index.html'))) return join(siteDir, dir)
  }
  throw new Error('La construction a réussi mais aucun dossier avec index.html n’a été trouvé.')
}

/** Pousse le dossier d'aperçu sur la branche apercu/<site> de ce dépôt (un seul commit, remplacé). */
export function pushPreview({ folder, repoUrl, branch }) {
  const work = mkdtempSync(join(tmpdir(), 'pk-apercu-'))
  cpSync(folder, work, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/node_modules') })
  git(work, ['init', '-q', '-b', 'apercu'])
  git(work, ['add', '-A'])
  git(work, ['-c', 'user.name=ProtoKomo', '-c', 'user.email=protokomo@users.noreply.github.com', 'commit', '-q', '-m', 'Aperçu'])
  git(work, ['push', '-q', '--force', repoUrl, `HEAD:refs/heads/${branch}`])
  return git(work, ['rev-parse', 'HEAD'])
}

/** Déroulé complet d'une demande. Exporté pour les tests. */
export async function main(env = process.env, deps = {}) {
  const site = env.PK_SITE ?? ''
  const id = env.PK_REQUEST_ID ?? ''
  const mode = env.PK_MODE || 'demande'
  if (!/^[\w.-]+\/[\w.-]+$/.test(site) || !/^[\w-]{6,64}$/.test(id)) throw new Error('Demande invalide')
  const posteRepo = env.GITHUB_REPOSITORY
  const status = deps.status ?? new StatusPublisher({ token: env.GITHUB_TOKEN, repo: posteRepo, id })
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd()
  const siteDir = join(workspace, 'site')
  const say = (label) => status.update({ activite: [...status.state.activite, label].slice(-30) })

  await status.ensureBranch?.()
  await status.update({ etat: 'travail', activite: ['Le poste de travail est prêt'] }, { now: true })

  try {
    const siteToken = env.PROTOKOMO_GITHUB_TOKEN
    if (!siteToken) throw new Error('Le jeton GitHub du poste (secret PROTOKOMO_GITHUB_TOKEN) est manquant. Refaites l’installation du poste dans ProtoKomo.')
    const siteUrl = deps.siteUrl ?? `${GIT_HOST.replace('https://', `https://x-access-token:${siteToken}@`)}/${site}.git`

    // Copie du site, sur le brouillon s'il existe.
    say('Ouvre le site')
    if (!existsSync(join(siteDir, '.git'))) {
      try { execFileSync('git', ['clone', '-q', siteUrl, siteDir], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch {
        throw new Error('Le poste n’a pas pu ouvrir le site : vérifiez que le jeton GitHub du poste a accès à ce dépôt.')
      }
    }
    const main = git(siteDir, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).replace('origin/', '')
    if (tryGit(siteDir, ['ls-remote', '--exit-code', '--heads', 'origin', DRAFT]) !== null) {
      git(siteDir, ['fetch', '-q', 'origin', DRAFT])
      git(siteDir, ['checkout', '-q', '-B', DRAFT, `origin/${DRAFT}`])
    } else {
      git(siteDir, ['checkout', '-q', '-B', DRAFT])
    }
    const user = deps.identity ?? (await api(siteToken, 'GET', '/user')).json
    const name = user?.name || user?.login || 'ProtoKomo'
    const email = user?.id && user?.login ? `${user.id}+${user.login}@users.noreply.github.com` : 'protokomo@users.noreply.github.com'
    git(siteDir, ['config', 'user.name', name])
    git(siteDir, ['config', 'user.email', email])

    const commitAndPush = (message) => {
      git(siteDir, ['add', '-A'])
      if (!git(siteDir, ['status', '--porcelain'])) return null
      git(siteDir, ['commit', '-q', '-m', message])
      git(siteDir, ['push', '-q', '-u', 'origin', DRAFT])
      return git(siteDir, ['rev-parse', 'HEAD'])
    }

    let reply = ''
    if (mode === 'annuler') {
      const ahead = Number(git(siteDir, ['rev-list', '--count', `origin/${main}..HEAD`]))
      if (ahead === 0) {
        reply = 'Il n’y a aucune modification à annuler : le brouillon est identique au site publié.'
      } else {
        const title = git(siteDir, ['log', '-1', '--format=%s'])
        const isMerge = git(siteDir, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length > 2
        git(siteDir, ['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), 'HEAD'])
        git(siteDir, ['push', '-q', '-u', 'origin', DRAFT])
        status.state.commit = git(siteDir, ['rev-parse', 'HEAD'])
        reply = `La dernière modification (« ${title} ») est annulée.`
      }
    } else if (mode === 'demande' || mode === 'maj') {
      if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) {
        throw new Error('Claude n’est pas connecté au poste (secret CLAUDE_CODE_OAUTH_TOKEN manquant). Faites « Connecter Claude » dans ProtoKomo.')
      }
      let prompt = env.PK_PROMPT ?? ''
      if (mode === 'maj') {
        git(siteDir, ['fetch', '-q', 'origin', main])
        const merged = tryGit(siteDir, ['merge', '--no-edit', `origin/${main}`])
        if (merged !== null) {
          prompt = ''
          reply = 'Le brouillon intègre maintenant les dernières modifications du site publié.'
          git(siteDir, ['push', '-q', '-u', 'origin', DRAFT])
        } else {
          prompt = 'Le site a été modifié ailleurs pendant que le brouillon avançait : il y a des conflits de fusion (marqueurs <<<<<<< dans les fichiers). Résous-les en gardant les deux intentions, sans rien perdre, puis explique simplement ce que tu as fait.'
        }
      }
      if (prompt) {
        say('Claude Code démarre')
        const outcome = await (deps.runClaude ?? runClaude)({
          cwd: siteDir,
          prompt,
          resume: env.PK_NOUVELLE !== 'true' && hasPreviousSession(env.PK_CLAUDE_SESSIONS ?? join(env.HOME ?? '', '.claude', 'projects')),
          onActivity: say,
          onText: (text) => status.update({ reponse: text }),
          onLimits: (limits) => status.update({ limites: limits })
        })
        if (!outcome.ok) throw new Error(humanizeClaudeError(outcome.error))
        reply = outcome.reply
        if (mode === 'maj') {
          git(siteDir, ['add', '-A'])
          git(siteDir, ['-c', 'core.editor=true', 'commit', '-q', '--no-edit'])
          git(siteDir, ['push', '-q', '-u', 'origin', DRAFT])
          status.state.commit = git(siteDir, ['rev-parse', 'HEAD'])
        } else {
          say('Enregistre le brouillon')
          status.state.commit = commitAndPush(commitMessage(reply))
        }
      }
    }

    // Aperçu : construit seulement si le site se construit (sinon l'app lit le brouillon directement).
    let apercu = null
    let apercuErreur = null
    try {
      const folder = (deps.buildPreview ?? buildPreview)(siteDir, (step) => say(step === 'Construction' ? 'Construit l’aperçu' : 'Prépare l’aperçu'))
      if (folder) {
        const branch = `apercu/${siteSlug(site)}`
        const repoUrl = deps.posteUrl ?? `${GIT_HOST.replace('https://', `https://x-access-token:${env.GITHUB_TOKEN}@`)}/${posteRepo}.git`
        apercu = { branche: branch, sha: pushPreview({ folder, repoUrl, branch }) }
      }
    } catch (err) {
      apercuErreur = `L’aperçu n’a pas pu être construit : ${String(err.stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300)}`
    }

    await status.update({ etat: 'termine', reponse: reply || status.state.reponse, apercu, apercuErreur }, { now: true })
  } catch (err) {
    await status.update({ etat: 'erreur', erreur: err.message }, { now: true })
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
