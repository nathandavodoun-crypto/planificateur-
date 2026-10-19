// Section "Écran d'accueil" des Réglages : activer/désactiver, durée, et
// gestion des images (ajout direct depuis la photothèque, suppression, aperçu).
// Les images vivent dans IndexedDB (voir splash.js), pas dans le store.

import { updateSettings } from '../store.js';
import { listSplashImages, addSplashImageFile, deleteSplashImage, previewSplash } from '../splash.js';

export function renderSplashSection(state) {
  const cfg = state.settings.splash || { enabled: true, seconds: 4 };
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `
    <h2>Écran d'accueil</h2>
    <p class="meta">À chaque ouverture de l'app, une de tes images s'affiche avant le planning. Elles sont gardées sur ton téléphone uniquement (rien n'est envoyé ni publié).</p>
  `;

  const form = document.createElement('form');
  form.className = 'settings-form';
  form.innerHTML = `
    <label class="checkbox-row">
      <input type="checkbox" name="enabled" ${cfg.enabled !== false ? 'checked' : ''} />
      <span>Afficher l'écran d'accueil au lancement</span>
    </label>
    <label>Durée d'affichage (secondes, 0 = jusqu'au toucher)
      <input type="number" name="seconds" min="0" max="30" step="1" value="${cfg.seconds ?? 4}" />
    </label>
    <button type="submit" class="btn-primary">Enregistrer</button>
  `;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = new FormData(form);
    updateSettings({ splash: { enabled: data.get('enabled') === 'on', seconds: Number(data.get('seconds')) || 0 } });
  });
  section.appendChild(form);

  // ---- Images ---------------------------------------------------------------
  const status = document.createElement('p');
  status.className = 'meta';
  const grid = document.createElement('div');
  grid.className = 'splash-grid';

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.hidden = true;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-secondary';
  addBtn.textContent = '🖼️ Ajouter des images';
  addBtn.addEventListener('click', () => picker.click());

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'btn-secondary';
  previewBtn.textContent = '👁️ Aperçu';
  previewBtn.addEventListener('click', () => previewSplash());

  const row = document.createElement('div');
  row.className = 'vacation-actions';
  row.append(addBtn, previewBtn);

  const urls = [];
  async function refresh() {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    grid.innerHTML = '';
    const rows = await listSplashImages();
    status.textContent = rows.length
      ? `${rows.length} image${rows.length > 1 ? 's' : ''} — l'une d'elles est tirée au sort à chaque ouverture.`
      : "Aucune image pour l'instant : un écran d'accueil par défaut s'affiche. Ajoute tes images avec le bouton ci-dessous.";
    for (const r of rows) {
      const url = URL.createObjectURL(r.blob);
      urls.push(url);
      const cell = document.createElement('div');
      cell.className = 'splash-thumb';
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Supprimer cette image';
      del.addEventListener('click', async () => {
        if (!confirm('Supprimer cette image de l\'écran d\'accueil ?')) return;
        await deleteSplashImage(r.id);
        refresh();
      });
      cell.append(img, del);
      grid.appendChild(cell);
    }
  }

  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    if (files.length === 0) return;
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      status.textContent = `Ajout… ${i + 1}/${files.length}`;
      try {
        await addSplashImageFile(files[i]);
        ok++;
      } catch (e) {
        console.warn('Image non ajoutée :', files[i].name, e);
        failed++;
      }
    }
    await refresh();
    if (failed) status.textContent += ` (${failed} fichier${failed > 1 ? 's' : ''} n'a pas pu être ajouté${failed > 1 ? 's' : ''})`;
  });

  section.append(row, picker, status, grid);
  refresh();
  return section;
}
