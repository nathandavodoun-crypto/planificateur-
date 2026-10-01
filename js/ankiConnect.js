// Liaison avec Anki Desktop via AnkiConnect (extension Anki qui ouvre un
// petit serveur local pendant qu'Anki est lancé sur l'ordinateur). Ne marche
// que depuis l'ordinateur où Anki tourne — AnkiDroid (téléphone) n'expose
// rien de ce genre, et il n'y a pas d'API publique AnkiWeb. Aucune donnée
// de révision n'est importée ici : juste les noms des paquets, pour ne pas
// avoir à les retaper à la main dans "Ajouter un chapitre".

const ANKI_CONNECT_URL = 'http://127.0.0.1:8765';

async function invoke(action, params = {}) {
  let response;
  try {
    response = await fetch(ANKI_CONNECT_URL, {
      method: 'POST',
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch (e) {
    throw new Error(
      "Impossible de joindre Anki. Vérifie qu'Anki Desktop est ouvert sur cet ordinateur, que l'extension AnkiConnect est installée, et que cette adresse est autorisée dans sa configuration (voir Réglages)."
    );
  }
  const data = await response.json();
  if (data.error) throw new Error(`AnkiConnect a répondu une erreur : ${data.error}`);
  return data.result;
}

/** Les noms de paquets Anki (hors "Default"/"Par défaut"), triés. */
export async function fetchDeckNames() {
  const names = await invoke('deckNames');
  return names.filter((n) => n !== 'Default' && n !== 'Par défaut').sort((a, b) => a.localeCompare(b));
}

/**
 * Déduit matière + titre à partir d'un nom de paquet Anki. Les paquets
 * hiérarchiques ("Maths::Intégrales") donnent la matière (1er segment,
 * rapproché d'une matière existante si le libellé correspond) et le titre
 * (dernier segment) ; un paquet simple ("Intégrales") devient juste un titre,
 * matière par défaut "Autre".
 */
export function deckNameToChapter(deckName, subjects) {
  const parts = deckName.split('::');
  const fallback = subjects.find((s) => s.id === 'autre') || subjects[0];
  if (parts.length === 1) {
    return { subject: fallback.id, title: parts[0] };
  }
  const match = subjects.find((s) => s.label.toLowerCase() === parts[0].toLowerCase());
  return { subject: match ? match.id : fallback.id, title: parts[parts.length - 1] };
}
