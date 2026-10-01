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
  deactivateRecurringColleTemplate,
  exportBackup,
  importBackup,
} from '../store.js';
import { formatDateFR } from '../utils/date.js';
import { isSupported as notificationsSupported, requestPermission as requestNotificationPermission } from '../notifications.js';

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
  wrapper.appendChild(renderNotificationsSection(state));
  wrapper.appendChild(renderColleAndRepetitionSection(state));
  wrapper.appendChild(renderAnkiSection());
  wrapper.appendChild(renderSubjectsSection(state));
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

function renderNotificationsSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = '<h2>Notifications</h2>';

  const n = state.settings.notifications;

  const notice = document.createElement('p');
  notice.className = 'notice';
  notice.textContent =
    "Sans serveur, aucune notification n'est garantie quand l'app est totalement fermée (téléphone ou ordinateur) — ça ne peut vérifier que pendant qu'elle est ouverte, ou dès que tu la rouvres. Sur ordinateur, un onglet ouvert en arrière-plan reste actif bien plus longtemps qu'un téléphone, donc c'est plus fiable tant que le navigateur tourne.";
  section.appendChild(notice);

  if (!notificationsSupported()) {
    const unsupported = document.createElement('p');
    unsupported.className = 'notice';
    unsupported.textContent = "Ce navigateur ne supporte pas les notifications.";
    section.appendChild(unsupported);
    return section;
  }

  const form = document.createElement('form');
  form.className = 'settings-form';
  form.innerHTML = `
    <label class="checkbox-row">
      <input type="checkbox" name="enabled" ${n.enabled ? 'checked' : ''} />
      Activer les notifications
    </label>
    <div class="settings-grid">
      <label>Rappel avant le début d'une session (min)
        <input type="number" name="notifyMinutesBeforeSessionStart" min="0" step="5" value="${n.notifyMinutesBeforeSessionStart}" />
      </label>
      <label>Alerte échéance proche (heures avant)
        <input type="number" name="notifyDeadlineWarningHoursBefore" min="1" step="1" value="${n.notifyDeadlineWarningHoursBefore}" />
      </label>
    </div>
    <button type="submit" class="btn-primary">Enregistrer</button>
  `;

  const enabledCheckbox = form.elements.enabled;
  enabledCheckbox.addEventListener('change', async () => {
    if (enabledCheckbox.checked) {
      const permission = await requestNotificationPermission();
      if (permission !== 'granted') {
        alert("Les notifications ont été refusées (ou le navigateur n'a pas répondu) — vérifie les réglages de notifications de ton navigateur/téléphone pour ce site.");
        enabledCheckbox.checked = false;
      }
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    updateSettings({
      notifications: {
        ...state.settings.notifications,
        enabled: data.get('enabled') === 'on',
        notifyMinutesBeforeSessionStart: Number(data.get('notifyMinutesBeforeSessionStart')),
        notifyDeadlineWarningHoursBefore: Number(data.get('notifyDeadlineWarningHoursBefore')),
      },
    });
  });

  section.appendChild(form);
  return section;
}

// ---------------------------------------------------------------------------

function renderColleAndRepetitionSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = '<h2>Colles et répétition espacée</h2>';

  const form = document.createElement('form');
  form.className = 'settings-form';
  const c = state.settings.colle;
  const sr = state.settings.spacedRepetition;
  form.innerHTML = `
    <div class="settings-grid">
      <label>Révision colle : au plus tôt (jours avant)
        <input type="number" name="revisionLeadDaysMax" min="0" step="1" value="${c.revisionLeadDaysMax}" />
      </label>
      <label>Révision colle : au plus tard (jours avant)
        <input type="number" name="revisionLeadDaysMin" min="0" step="1" value="${c.revisionLeadDaysMin}" />
      </label>
      <label>Durée de révision de colle par défaut (min)
        <input type="number" name="colleDefaultDurationMinutes" min="10" step="5" value="${c.defaultDurationMinutes}" />
      </label>
      <label>Minutes en plus par chapitre supplémentaire
        <input type="number" name="extraMinutesPerExtraChapter" min="0" step="5" value="${c.extraMinutesPerExtraChapter}" />
      </label>
      <label>Intervalles de répétition espacée (jours, séparés par virgules)
        <input type="text" name="baseIntervalsDays" value="${sr.baseIntervalsDays.join(', ')}" />
      </label>
      <label>Durée d'une révision espacée (min)
        <input type="number" name="spacedDefaultDurationMinutes" min="5" step="5" value="${sr.defaultDurationMinutes}" />
      </label>
      <label>Rattrapage si révisions dépassées (jours)
        <input type="number" name="catchUpWindowDays" min="1" step="1" value="${sr.catchUpWindowDays}" />
      </label>
      <label>Étalement des rattrapages en import groupé (jours)
        <input type="number" name="bulkImportSpreadDays" min="1" step="1" value="${sr.bulkImportSpreadDays}" />
      </label>
    </div>
    <button type="submit" class="btn-primary">Enregistrer</button>
  `;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const intervals = data
      .get('baseIntervalsDays')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    updateSettings({
      colle: {
        ...state.settings.colle,
        revisionLeadDaysMin: Number(data.get('revisionLeadDaysMin')),
        revisionLeadDaysMax: Number(data.get('revisionLeadDaysMax')),
        defaultDurationMinutes: Number(data.get('colleDefaultDurationMinutes')),
        extraMinutesPerExtraChapter: Number(data.get('extraMinutesPerExtraChapter')),
      },
      spacedRepetition: {
        ...state.settings.spacedRepetition,
        baseIntervalsDays: intervals.length ? intervals : state.settings.spacedRepetition.baseIntervalsDays,
        defaultDurationMinutes: Number(data.get('spacedDefaultDurationMinutes')),
        catchUpWindowDays: Number(data.get('catchUpWindowDays')),
        bulkImportSpreadDays: Number(data.get('bulkImportSpreadDays')),
      },
    });
  });

  section.appendChild(form);

  const activeTemplates = state.recurringColleTemplates.filter((t) => t.active);
  if (activeTemplates.length > 0) {
    const listTitle = document.createElement('p');
    listTitle.className = 'notice';
    listTitle.textContent = 'Colles récurrentes actives :';
    section.appendChild(listTitle);

    for (const tmpl of activeTemplates) {
      const subj = (state.settings.subjects || []).find((s) => s.id === tmpl.subject);
      const dayLabel = DAYS_DISPLAY.find((d) => d.index === tmpl.dayOfWeek)?.label || '';
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div>
          <strong>${escapeHtml(tmpl.label || 'Colle')}</strong>
          <div class="meta">${escapeHtml(subj ? subj.label : tmpl.subject)} · ${dayLabel} ${tmpl.startTime}–${tmpl.endTime}</div>
        </div>
      `;
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Arrêter cette colle récurrente';
      delBtn.addEventListener('click', () => deactivateRecurringColleTemplate(tmpl.id));
      item.appendChild(delBtn);
      section.appendChild(item);
    }
  }

  return section;
}

// ---------------------------------------------------------------------------

function renderAnkiSection() {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `
    <h2>Lien avec Anki</h2>
    <p class="notice">
      Depuis "Ajouter → Chapitre → Importer plusieurs chapitres d'un coup", un bouton permet de récupérer les noms de tes paquets Anki, pour ne pas avoir à les retaper. Ça ne marche que depuis cet ordinateur, avec Anki Desktop ouvert — AnkiDroid (téléphone) et AnkiWeb ne permettent pas cette liaison.
      Seuls les <strong>noms</strong> des paquets sont récupérés — le planificateur garde son propre système de répétition espacée (J+1/J+7/J+30), indépendant de celui d'Anki.
    </p>
    <p class="notice">
      À faire une seule fois dans Anki :
      1) Outils → Modules complémentaires → installer "AnkiConnect" (code 2055492159) si ce n'est pas déjà fait, puis redémarrer Anki.
      2) Outils → Modules complémentaires → sélectionner AnkiConnect → Configuration.
      3) Dans le champ <code>webCorsOriginList</code>, ajouter cette adresse : <code>https://nathandavodoun-crypto.github.io</code>
      4) Enregistrer, puis redémarrer Anki.
    </p>
  `;
  return section;
}

// ---------------------------------------------------------------------------

function renderSubjectsSection(state) {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML =
    '<h2>Mes matières</h2><p class="notice">L\'ordre sert de priorité quand plusieurs chapitres doivent être rattrapés en même temps (import groupé) — la première matière de la liste passe en premier.</p>';

  const subjects = state.settings.subjects;
  subjects.forEach((subj, i) => {
    const item = document.createElement('div');
    item.className = 'list-item subject-item';
    item.style.borderLeft = `4px solid ${subj.color}`;
    item.innerHTML = `<strong>${escapeHtml(subj.label)}</strong>`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const upBtn = document.createElement('button');
    upBtn.className = 'btn-undo';
    upBtn.textContent = '↑';
    upBtn.title = 'Monter';
    upBtn.disabled = i === 0;
    upBtn.addEventListener('click', () => {
      const reordered = [...subjects];
      [reordered[i - 1], reordered[i]] = [reordered[i], reordered[i - 1]];
      updateSettings({ subjects: reordered });
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'btn-undo';
    downBtn.textContent = '↓';
    downBtn.title = 'Descendre';
    downBtn.disabled = i === subjects.length - 1;
    downBtn.addEventListener('click', () => {
      const reordered = [...subjects];
      [reordered[i + 1], reordered[i]] = [reordered[i], reordered[i + 1]];
      updateSettings({ subjects: reordered });
    });

    actions.append(upBtn, downBtn);
    item.appendChild(actions);
    section.appendChild(item);
  });

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
