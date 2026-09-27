// Réglages : contraintes de temps, emploi du temps récurrent, événements
// ponctuels (colles/DS/imprévus), et sauvegarde manuelle des données.
// Configurable une fois, modifiable ensuite — comme demandé.

import {
  getState,
  updateSettings,
  addWeeklyConstraint,
  deleteWeeklyConstraint,
  addOneOffEvent,
  deleteOneOffEvent,
  exportBackup,
  importBackup,
} from '../store.js';
import { formatDateFR } from '../utils/date.js';

const DAYS_DISPLAY = [
  { index: 1, label: 'Lun' },
  { index: 2, label: 'Mar' },
  { index: 3, label: 'Mer' },
  { index: 4, label: 'Jeu' },
  { index: 5, label: 'Ven' },
  { index: 6, label: 'Sam' },
  { index: 0, label: 'Dim' },
];

const CONSTRAINT_CATEGORIES = { cours: 'Cours', sport: 'Sport', repas: 'Repas', trajet: 'Trajet', autre: 'Autre' };
const EVENT_CATEGORIES = { colle: 'Colle', ds: 'DS', adhoc: 'Imprévu', autre: 'Autre' };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function renderSettingsView(container) {
  const state = getState();
  const wrapper = document.createElement('div');
  wrapper.className = 'view view-settings';

  wrapper.appendChild(renderGeneralSection(state));
  wrapper.appendChild(renderConstraintsSection(state));
  wrapper.appendChild(renderEventsSection(state));
  wrapper.appendChild(renderBackupSection());

  container.appendChild(wrapper);
}

// ---------------------------------------------------------------------------

function renderGeneralSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = '<h2>Réglages généraux</h2>';

  const form = document.createElement('form');
  form.className = 'settings-form';
  const s = state.settings;
  form.innerHTML = `
    <div class="settings-grid">
      <label>Début de journée
        <input type="time" name="dayStartTime" value="${s.dayStartTime}" />
      </label>
      <label>Rien après (couvre-feu)
        <input type="time" name="dayEndCutoff" value="${s.dayEndCutoff}" />
      </label>
      <label>Durée max d'une session (min)
        <input type="number" name="maxSessionLengthMinutes" min="15" step="5" value="${s.maxSessionLengthMinutes}" />
      </label>
      <label>Pause entre sessions (min)
        <input type="number" name="breakDurationMinutes" min="0" step="5" value="${s.breakDurationMinutes}" />
      </label>
      <label>Charge max / jour de semaine (min)
        <input type="number" name="dailyCapWeekdayMinutes" min="0" step="15" value="${s.dailyCapWeekdayMinutes}" />
      </label>
      <label>Charge max / jour de week-end (min)
        <input type="number" name="dailyCapWeekendMinutes" min="0" step="15" value="${s.dailyCapWeekendMinutes}" />
      </label>
      <label>Marge de sécurité avant échéance (jours)
        <input type="number" name="safetyMarginDays" min="0" step="1" value="${s.safetyMarginDays}" />
      </label>
    </div>
    <button type="submit" class="btn-primary">Enregistrer</button>
  `;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    updateSettings({
      dayStartTime: data.get('dayStartTime'),
      dayEndCutoff: data.get('dayEndCutoff'),
      maxSessionLengthMinutes: Number(data.get('maxSessionLengthMinutes')),
      breakDurationMinutes: Number(data.get('breakDurationMinutes')),
      dailyCapWeekdayMinutes: Number(data.get('dailyCapWeekdayMinutes')),
      dailyCapWeekendMinutes: Number(data.get('dailyCapWeekendMinutes')),
      safetyMarginDays: Number(data.get('safetyMarginDays')),
    });
  });

  section.appendChild(form);
  return section;
}

// ---------------------------------------------------------------------------

function renderConstraintsSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = '<h2>Emploi du temps récurrent</h2><p class="notice">Cours, sport, repas, trajets... tout ce qui revient chaque semaine.</p>';

  for (const c of state.weeklyConstraints) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const days = c.daysOfWeek
      .map((i) => DAYS_DISPLAY.find((d) => d.index === i)?.label)
      .filter(Boolean)
      .join(' ');
    item.innerHTML = `
      <div>
        <div><strong>${escapeHtml(CONSTRAINT_CATEGORIES[c.category] || c.category)}</strong> — ${escapeHtml(c.label)}</div>
        <div class="meta">${days} · ${c.startTime}–${c.endTime}</div>
      </div>
    `;
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', () => deleteWeeklyConstraint(c.id));
    item.appendChild(delBtn);
    section.appendChild(item);
  }

  const form = document.createElement('form');
  form.className = 'constraint-form';
  form.innerHTML = `
    <label>Libellé
      <input type="text" name="label" placeholder="ex. Musculation" required />
    </label>
    <label>Catégorie
      <select name="category">
        ${Object.entries(CONSTRAINT_CATEGORIES).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
      </select>
    </label>
    <div class="days-picker">
      ${DAYS_DISPLAY.map((d) => `<label><input type="checkbox" name="day" value="${d.index}" />${d.label}</label>`).join('')}
    </div>
    <div class="settings-grid">
      <label>Début
        <input type="time" name="startTime" value="18:00" required />
      </label>
      <label>Fin
        <input type="time" name="endTime" value="19:00" required />
      </label>
    </div>
    <button type="submit" class="btn-secondary">Ajouter ce créneau</button>
  `;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const daysOfWeek = [...form.querySelectorAll('input[name="day"]:checked')].map((el) => Number(el.value));
    if (daysOfWeek.length === 0) {
      alert('Choisis au moins un jour.');
      return;
    }
    addWeeklyConstraint({
      label: data.get('label'),
      category: data.get('category'),
      daysOfWeek,
      startTime: data.get('startTime'),
      endTime: data.get('endTime'),
    });
  });
  section.appendChild(form);

  return section;
}

// ---------------------------------------------------------------------------

function renderEventsSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = '<h2>Colles, DS et imprévus</h2><p class="notice">Un événement à une date précise — la case "Imprévu" sert à bloquer un créneau ponctuel (sortie, rendez-vous...).</p>';

  const upcoming = [...state.oneOffEvents].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const ev of upcoming) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div>
        <div><strong>${escapeHtml(EVENT_CATEGORIES[ev.category] || ev.category)}</strong> — ${escapeHtml(ev.label)}</div>
        <div class="meta">${formatDateFR(ev.date)} · ${ev.startTime}–${ev.endTime}</div>
      </div>
    `;
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', () => deleteOneOffEvent(ev.id));
    item.appendChild(delBtn);
    section.appendChild(item);
  }

  const form = document.createElement('form');
  form.className = 'event-form';
  form.innerHTML = `
    <label>Libellé
      <input type="text" name="label" placeholder="ex. DS de Maths" required />
    </label>
    <label>Catégorie
      <select name="category">
        ${Object.entries(EVENT_CATEGORIES).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}
      </select>
    </label>
    <label>Date
      <input type="date" name="date" required />
    </label>
    <div class="settings-grid">
      <label>Début
        <input type="time" name="startTime" value="14:00" required />
      </label>
      <label>Fin
        <input type="time" name="endTime" value="16:00" required />
      </label>
    </div>
    <label>Matière concernée (facultatif)
      <select name="subject">
        <option value="">—</option>
        ${state.settings.subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join('')}
      </select>
    </label>
    <button type="submit" class="btn-secondary">Ajouter cet événement</button>
  `;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    addOneOffEvent({
      label: data.get('label'),
      category: data.get('category'),
      date: data.get('date'),
      startTime: data.get('startTime'),
      endTime: data.get('endTime'),
      subject: data.get('subject') || null,
      createdVia: data.get('category') === 'adhoc' ? 'adhoc' : 'planned',
    });
  });
  section.appendChild(form);

  return section;
}

// ---------------------------------------------------------------------------

function renderBackupSection() {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `
    <h2>Sauvegarde</h2>
    <p class="notice">Tes données ne vivent que sur cet appareil. Exporte régulièrement une copie, surtout avant de changer de téléphone.</p>
  `;

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-secondary';
  exportBtn.textContent = 'Exporter mes données (.json)';
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([exportBackup()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planificateur-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const importLabel = document.createElement('label');
  importLabel.className = 'btn-secondary';
  importLabel.style.cssText = 'display:inline-block;text-align:center;cursor:pointer;';
  importLabel.textContent = 'Importer une sauvegarde';
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', () => {
    const file = importInput.files[0];
    if (!file) return;
    if (!confirm('Importer cette sauvegarde remplacera toutes les données actuelles. Continuer ?')) return;
    file.text().then((text) => {
      try {
        importBackup(text);
      } catch (e) {
        alert("Ce fichier n'a pas pu être lu comme une sauvegarde valide.");
      }
    });
  });
  importLabel.appendChild(importInput);

  section.append(exportBtn, importLabel);
  return section;
}
