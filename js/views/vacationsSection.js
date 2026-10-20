// Section "Vacances & repos" des Réglages : périodes de vacances (rythme
// léger, cours suspendus), plan de rattrapage, bilan, et jours de repos
// protégés. Toute la logique est dans vacations.js / scheduler.js / stats.js ;
// ici il n'y a que l'interface.

import {
  addVacation,
  deleteVacation,
  updateVacation,
  planCatchUpForVacation,
  addRestDays,
  deleteOneOffEvent,
} from '../store.js';
import { vacationReport } from '../stats.js';
import { formatDateFR, formatDuration, todayISO } from '../utils/date.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const STATUS_LABELS = { a_venir: 'à venir', en_cours: 'en cours', terminee: 'terminées' };

function renderReport(state, vacation) {
  const r = vacationReport(state, vacation, new Date());
  const lines = [];
  lines.push(`<strong>Bilan — ${STATUS_LABELS[r.status]}</strong>`);
  lines.push(`🕒 ${formatDuration(r.minutesDone)} travaillées sur ${r.workedDays} jour${r.workedDays > 1 ? 's' : ''} (${r.sessionsDone} séance${r.sessionsDone > 1 ? 's' : ''})`);
  if (r.status !== 'terminee') lines.push(`📅 ${formatDuration(r.minutesPlanned)} encore prévues`);
  lines.push(`📚 ${r.chapterReviews} révision${r.chapterReviews > 1 ? 's' : ''} de chapitre faite${r.chapterReviews > 1 ? 's' : ''}` + (r.chaptersStillLate ? ` · ${r.chaptersStillLate} encore en retard` : ''));
  if (r.ahead.total > 0) {
    lines.push(`⏩ Devoirs de la reprise : ${r.ahead.finished}/${r.ahead.total} finis` + (r.ahead.remainingMinutes ? ` · reste ${formatDuration(r.ahead.remainingMinutes)}` : ' 🎉'));
  }
  if (r.restDays) lines.push(`😴 ${r.restDays} jour${r.restDays > 1 ? 's' : ''} de repos`);
  const box = document.createElement('div');
  box.className = 'vacation-report';
  box.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  return box;
}

// Mode focus : un seul chapitre par jour, en une longue séance.
function renderFocusControls(v) {
  const box = document.createElement('div');
  box.className = 'vacation-focus';
  const on = v.focusMode !== false;
  const minutes = v.focusMinutes ?? 120;
  box.innerHTML = `
    <label class="checkbox-row">
      <input type="checkbox" ${on ? 'checked' : ''} />
      <span>🎯 Mode focus : un chapitre par jour, en une longue séance</span>
    </label>
  `;
  const check = box.querySelector('input');
  check.addEventListener('change', () => updateVacation(v.id, { focusMode: check.checked }));
  if (on) {
    const label = document.createElement('label');
    label.innerHTML = `Durée de la séance par chapitre (min)
      <input type="number" min="30" max="240" step="15" value="${minutes}" />`;
    const input = label.querySelector('input');
    input.addEventListener('change', () => updateVacation(v.id, { focusMinutes: Math.min(240, Math.max(30, Number(input.value) || 120)) }));
    box.appendChild(label);
  }
  return box;
}

export function renderVacationsSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = '<h2>Vacances &amp; repos</h2>';

  const intro = document.createElement('p');
  intro.className = 'meta';
  intro.textContent =
    "Pendant une période de vacances, tes cours et le trajet retour ne bloquent plus rien, la journée de travail est plus légère, et les devoirs dus juste après la reprise sont avancés. Un jour de repos n'a jamais de travail : ce qui était prévu est replacé ailleurs.";
  section.appendChild(intro);

  // ---- Périodes de vacances ----------------------------------------------
  const vacations = [...(state.vacations || [])].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  for (const v of vacations) {
    const item = document.createElement('div');
    item.className = 'list-item vacation-item';
    const head = document.createElement('div');
    head.innerHTML = `
      <div><strong>🏖️ ${escapeHtml(v.label)}</strong></div>
      <div class="meta">${formatDateFR(v.startDate)} → ${formatDateFR(v.endDate)} · max ${formatDuration(v.dailyCapMinutes)}/jour dès ${v.startTime}${v.workAhead ? ` · avance les devoirs dus jusqu'à ${v.aheadDays} j après la reprise` : ''}</div>
    `;
    head.appendChild(renderFocusControls(v));
    head.appendChild(renderReport(state, v));

    const actions = document.createElement('div');
    actions.className = 'vacation-actions';

    if (todayISO(new Date()) <= v.endDate) {
      const catchUp = document.createElement('button');
      catchUp.type = 'button';
      catchUp.className = 'btn-secondary';
      catchUp.textContent = '📚 Répartir mon rattrapage';
      catchUp.title = 'Étale les révisions de chapitres en retard sur les jours libres de ces vacances';
      catchUp.addEventListener('click', () => {
        const n = planCatchUpForVacation(v.id);
        alert(n > 0 ? `${n} révision${n > 1 ? 's' : ''} de chapitre répartie${n > 1 ? 's' : ''} sur les jours libres des vacances.` : 'Aucune révision en retard à répartir.');
      });
      actions.appendChild(catchUp);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Supprimer cette période';
    del.addEventListener('click', () => {
      if (confirm(`Supprimer « ${v.label} » ? Les cours reprendront normalement sur ces dates.`)) deleteVacation(v.id);
    });
    actions.appendChild(del);

    item.append(head, actions);
    section.appendChild(item);
  }

  const form = document.createElement('form');
  form.className = 'event-form';
  const today = todayISO(new Date());
  form.innerHTML = `
    <h3>Ajouter des vacances</h3>
    <label>Nom
      <input type="text" name="label" value="Vacances" required />
    </label>
    <div class="settings-grid">
      <label>Du <input type="date" name="startDate" value="${today}" required /></label>
      <label>Au <input type="date" name="endDate" required /></label>
      <label>Travail max / jour (min)
        <input type="number" name="dailyCapMinutes" min="0" step="15" value="240" />
      </label>
      <label>Début de journée
        <input type="time" name="startTime" value="09:00" />
      </label>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" name="focusMode" checked />
      <span>🎯 Mode focus : chaque jour, un seul chapitre en révision, en une longue séance (au lieu de petits blocs sur toutes les matières).</span>
    </label>
    <label>Durée de la séance par chapitre (min)
      <input type="number" name="focusMinutes" min="30" max="240" step="15" value="120" />
    </label>
    <label class="checkbox-row">
      <input type="checkbox" name="workAhead" checked />
      <span>Avancer les devoirs dus dans les 7 jours après la reprise, pour les finir avant la fin des vacances.</span>
    </label>
    <button type="submit" class="btn-primary">Ajouter la période</button>
  `;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const startDate = data.get('startDate');
    const endDate = data.get('endDate');
    if (!startDate || !endDate || endDate < startDate) {
      alert('La date de fin doit être le même jour ou après la date de début.');
      return;
    }
    addVacation({
      label: data.get('label') || 'Vacances',
      startDate,
      endDate,
      dailyCapMinutes: Math.max(0, Number(data.get('dailyCapMinutes')) || 0),
      startTime: data.get('startTime') || '09:00',
      workAhead: data.get('workAhead') === 'on',
      focusMode: data.get('focusMode') === 'on',
      focusMinutes: Math.min(240, Math.max(30, Number(data.get('focusMinutes')) || 120)),
    });
  });
  section.appendChild(form);

  // ---- Jours de repos protégés ---------------------------------------------
  const restTitle = document.createElement('h3');
  restTitle.textContent = 'Jours de repos';
  section.appendChild(restTitle);

  const rest = state.oneOffEvents.filter((e) => e.category === 'repos' && e.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rest.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Aucun jour de repos à venir.';
    section.appendChild(empty);
  }
  for (const ev of rest) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div><strong>😴 ${escapeHtml(ev.label)}</strong><div class="meta">${formatDateFR(ev.date)}</div></div>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Retirer ce jour de repos';
    del.addEventListener('click', () => deleteOneOffEvent(ev.id));
    item.appendChild(del);
    section.appendChild(item);
  }

  const restForm = document.createElement('form');
  restForm.className = 'event-form';
  restForm.innerHTML = `
    <label>Nom
      <input type="text" name="label" value="Jour de repos" />
    </label>
    <div class="settings-grid">
      <label>Du <input type="date" name="from" value="${today}" required /></label>
      <label>Au <input type="date" name="to" value="${today}" required /></label>
    </div>
    <button type="submit" class="btn-primary">Protéger ces jours</button>
  `;
  restForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(restForm);
    const from = data.get('from');
    const to = data.get('to');
    if (!from || !to || to < from) {
      alert('La date de fin doit être le même jour ou après la date de début.');
      return;
    }
    addRestDays(String(data.get('label') || 'Jour de repos'), from, to);
  });
  section.appendChild(restForm);

  return section;
}
