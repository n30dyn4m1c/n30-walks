/**
 * "Unfinished walk" card: shown wherever a new walk could be started, so an
 * interrupted recording is never silently replaced.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/db';
import { recorder } from '../tracking/recorder';
import { trackTotals } from '../lib/stats';
import { distanceUnit, fmtDate, fmtDistance, fmtDuration } from '../lib/format';
import { useSettings, useToast } from './ui';
import type { RecordingDraft } from '../types';

export function DraftCard({ draft, onResumed }: { draft: RecordingDraft; onResumed?: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { units } = useSettings();
  const [busy, setBusy] = useState(false);
  const t = trackTotals(draft.points, draft.pauses);
  const last = draft.points[draft.points.length - 1]?.t ?? draft.updatedAt;
  const when = `${fmtDate(draft.startedAt)} ${new Date(draft.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast(`Could not do that: ${(e as Error).message}`); } finally { setBusy(false); }
  };

  return (
    <div className="card stack" role="region" aria-label="Unfinished walk">
      <strong>Unfinished {draft.mode === 'mixed' ? 'journey' : 'walk'}</strong>
      <span className="muted small">
        {fmtDistance(t.distanceM, units)} {distanceUnit(units)} · {fmtDuration(Math.max(0, (last - draft.startedAt) / 1000))} · started {when}.
        {' '}It was interrupted{draft.pausedAt != null ? ' while paused' : ''}.
      </span>
      <div className="row wrap">
        {draft.source !== 'simulated' && (
          <button className="btn primary sm" disabled={busy} onClick={() => run(async () => { await recorder.resumeDraft(draft); onResumed?.(); nav('/record'); })}>Resume</button>
        )}
        <button className="btn sm" disabled={busy} onClick={() => run(async () => {
          const id = await recorder.saveDraftAsActivity(draft);
          if (id) nav(`/activity/${id}`); else toast('Too short to save');
        })}>Save as is</button>
        <button className="btn ghost sm danger" disabled={busy} onClick={() => run(async () => {
          if (confirm('Discard this unfinished walk? It will not be saved.')) await db.drafts.delete('draft');
        })}>Discard</button>
      </div>
    </div>
  );
}
