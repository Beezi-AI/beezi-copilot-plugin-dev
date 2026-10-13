// The Copilot CLI's bring-your-own-key registry (providers.json, or the file COPILOT_PROVIDERS_CONFIG names): read-only,
// provider names only. The file holds base URLs, API keys and bearer tokens; none of those is ever read past the parse.
import fs from 'fs';
import path from 'path';
import { copilotHome } from '../../config/copilot-paths.mjs';
import { isPlain, nonEmpty } from '../../core/guards.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
// Model fields of events.jsonl records that name the model a session selected or ran on.
const MODEL_FIELDS = ['selectedModel', 'newModel', 'chosenModel', 'model'];

// COPILOT_PROVIDERS_CONFIG, else <COPILOT_HOME>/providers.json (config/copilot-paths.mjs has no helper for it yet).
function providersFile(env) {
  const custom = nonEmpty(env.COPILOT_PROVIDERS_CONFIG) ? env.COPILOT_PROVIDERS_CONFIG.trim() : null;
  return custom != null ? path.resolve(custom) : path.join(copilotHome(), 'providers.json');
}

// The provider names a registry text declares, lowercased; [] when it is not the documented { providers, models } shape. Pure.
export function parseProviderNames(text) {
  let parsed = null;
  try { parsed = JSON.parse(String(text).replace(/^﻿/, '')); } catch { return []; }
  if (!isPlain(parsed)) return [];
  const names = [];
  const add = (name) => {
    const n = nonEmpty(name) ? name.trim().toLowerCase() : null;
    if (n != null && n.indexOf('/') === -1 && names.indexOf(n) === -1) names.push(n);
  };
  for (const p of Array.isArray(parsed.providers) ? parsed.providers : []) if (isPlain(p)) add(p.name);
  for (const m of Array.isArray(parsed.models) ? parsed.models : []) if (isPlain(m)) add(m.provider);
  return names;
}

// The BYOK provider names this machine's Copilot CLI declares; [] without a readable registry. Sync; never throws.
export function byokProviderNames({ env = process.env } = {}) {
  try {
    const file = providersFile(env);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    return parseProviderNames(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// True when an event selected or ran a registry model: its selection id is '<provider>/<id>' for a declared provider.
// Unverified: that events.jsonl records the provider-qualified id, which is how the SDK names such a model. Pure.
export function usesProviderModel(events, names) {
  if (!Array.isArray(events) || !Array.isArray(names) || names.length === 0) return false;
  for (const e of events) {
    const d = e != null && isPlain(e.data) ? e.data : null;
    if (d == null) continue;
    for (const field of MODEL_FIELDS) {
      const model = typeof d[field] === 'string' ? d[field].trim().toLowerCase() : '';
      const slash = model.indexOf('/');
      if (slash > 0 && names.indexOf(model.slice(0, slash)) !== -1) return true;
    }
  }
  return false;
}
