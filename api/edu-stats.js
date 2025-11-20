import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

// ============================
// Chargement des JSON sans "assert"
// ============================

function loadJson(relativePath, fallback) {
  try {
    const filePath = path.join(process.cwd(), relativePath);
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Impossible de charger", relativePath, ":", e.message);
    return fallback;
  }
}

// sources.json à la racine du projet
const sourcesConfig = loadJson("sources.json", { sources: [] });

// data/official-sources.json (catalogue de sources)
const officialSources = loadJson("data/official-sources.json", {
  websites: [],
  apis: [],
});

// data/fr-esr-discipline-mapping.json (mapping programme -> discipline MESR)
const disciplineMapping = loadJson("data/fr-esr-discipline-mapping.json", []);

// ============================
// Client OpenAI
// ============================

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================
// 1) MESR / #dataESR (Masters FR)
// ============================

const MESR_DATASET =
  "fr-esr-insertion_professionnelle-master_donnees_nationales";
const MESR_BASE_URL =
  "https://data.enseignementsup-recherche.gouv.fr/api/records/1.0/search/";

/**
 * Essaie de deviner une discipline MESR à partir du nom du programme.
 * Utilise le mapping JSON (keywords -> discipline).
 */
function guessMesrDiscipline(program) {
  const norm = (program || "").toLowerCase();
  if (!norm) return null;

  for (const entry of disciplineMapping) {
    if (!entry?.discipline || !Array.isArray(entry.keywords)) continue;
    const match = entry.keywords.some((kw) =>
      norm.includes(String(kw || "").toLowerCase())
    );
    if (match) return entry.discipline;
  }
  return null;
}

/**
 * Appelle l'API MESR pour récupérer stats nationales d'insertion pro / salaire
 * par discipline de Master.
 * Retourne un bloc: { cost, averageSalary, employabilityRate, source }
 */
async function fetchMesrMasterStats(disciplineLabel, year = 2020) {
  if (!disciplineLabel) return null;

  const params = new URLSearchParams({
    dataset: MESR_DATASET,
    rows: "1",
    "refine.annee": String(year),
    "refine.disciplines": disciplineLabel,
  });

  const url = `${MESR_BASE_URL}?${params.toString()}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("MESR API error", resp.status, await resp.text());
      return null;
    }

    const json = await resp.json();
    if (!json.records || json.records.length === 0) return null;

    const f = json.records[0].fields || {};

    const tauxInsertion =
      f.taux_dinsertion ||
      f.taux_d_insertion ||
      f.taux_demploi ||
      f.taux_d_emploi ||
      null;

    const salaireNetMensuel =
      f.salaire_net_mensuel_median ||
      f.salaire_net_mensuel ||
      f.salaire_net_median ||
      null;

    let averageSalary = null;
    if (
      typeof salaireNetMensuel === "number" &&
      Number.isFinite(salaireNetMensuel)
    ) {
      // Approx net -> brut : x1.3 sur 12 mois
      averageSalary = Math.round(salaireNetMensuel * 12 * 1.3);
    }

    return {
      cost: null, // dataset national : pas les frais de scolarité
      averageSalary,
      employabilityRate:
        typeof tauxInsertion === "number" && Number.isFinite(tauxInsertion)
          ? Math.round(tauxInsertion)
          : null,
      source: `MESR – Enquête insertion professionnelle des diplômés de Master (${year}) – discipline "${disciplineLabel}"`,
    };
  } catch (err) {
    console.error("Erreur fetch MESR", err);
    return null;
  }
}

// ============================
// 2) Recherche "sites officiels" (DuckDuckGo)
// ============================

async function searchSources(query, domains) {
  const results = [];

  for (const domain of domains) {
    const url = `https://api.duckduckgo.com/?q=site:${domain}+${encodeURIComponent(
      query
    )}&format=json`;

    try {
      const resp = await fetch(url);
      const data = await resp.json();

      if (data?.RelatedTopics?.length > 0) {
        const topic = data.RelatedTopics[0];
        results.push({
          domain,
          url: topic.FirstURL || null,
          snippet: topic.Text || "Pas de données précises",
        });
      }
    } catch (err) {
      console.error(`Erreur recherche sur ${domain}:`, err.message);
    }
  }

  return results;
}

// ============================
// 3) Handler principal
// ============================

export default async function handler(req, res) {
  const { school, program } = req.query;

  if (!school || !program) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  const schoolTrimmed = String(school).trim();
  const programTrimmed = String(program).trim();

  const query = `${schoolTrimmed} ${programTrimmed} coût salaire employabilité`;

  // --- 3.1. Détecter si c'est un Master → tenter MESR d'abord
  let officialBlock = null;
  const isMasterLike = /master|m1|m2/i.test(programTrimmed);

  if (isMasterLike) {
    const mesrDiscipline = guessMesrDiscipline(programTrimmed);
    if (mesrDiscipline) {
      officialBlock = await fetchMesrMasterStats(mesrDiscipline);
    }
  }

  // --- 3.2. Recherche web sur les domaines "officiels"
  const domains =
    (sourcesConfig?.sources || []).flatMap((src) => src.domains || []) || [];

  const webResults = await searchSources(query, domains);

  // --- 3.3. Si on a au moins un bloc officiel (MESR ou web) → on fusionne avec l'IA
  if (officialBlock || webResults.length > 0) {
    const prompt = `
Tu es un assistant qui fusionne des statistiques officielles et des extraits de sites web.

École : "${schoolTrimmed}"
Programme : "${programTrimmed}"

BLOC DE DONNÉES OFFICIELLES (peut être null) :
${JSON.stringify(officialBlock, null, 2)}

EXTRAITS DE SITES WEB OFFICIELS (domaines écoles, INSEE, etc.) :
${JSON.stringify(webResults, null, 2)}

RÈGLES :
- Les chiffres du bloc officiel (par ex. MESR) priment toujours sur les extrapolations.
- Tu peux utiliser les extraits web pour COMPLÉTER ce qui est null (par ex. le coût quand il est clairement indiqué).
- N'invente JAMAIS de chiffres : si c'est ambigu ou non présent, laisse la valeur à null.
- Si les chiffres restent partiellement estimés, mentionne-le explicitement dans "source"
  (exemple : "MESR + estimation IA pour le coût, faute d'information officielle").

Renvoie STRICTEMENT un JSON avec les clés :

{
  "cost": nombre ou null,
  "averageSalary": nombre ou null,
  "employabilityRate": nombre ou null,
  "source": "description courte et honnête des sources utilisées (MESR, site école, estimation IA éventuelle)",
  "schoolQueried": "${schoolTrimmed}",
  "programQueried": "${programTrimmed}"
}
`;

    try {
      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });

      const raw = completion.choices[0].message.content;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        console.error("Parse JSON fusion officiel+web KO", raw);
        data = {
          cost: officialBlock?.cost ?? null,
          averageSalary: officialBlock?.averageSalary ?? null,
          employabilityRate: officialBlock?.employabilityRate ?? null,
          source:
            officialBlock?.source ||
            "Statistiques partiellement officielles, fusion IA non parsée",
          schoolQueried: schoolTrimmed,
          programQueried: programTrimmed,
        };
      }

      return res.json({
        ...data,
        refreshedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Erreur IA fusion sources officielles", error);
      return res
        .status(500)
        .json({ error: "Erreur IA fusion sources officielles" });
    }
  }

  // --- 3.4. Fallback : aucune source officielle → estimation IA pure

  try {
    const prompt = `
Aucune source officielle exploitable n'a été trouvée automatiquement pour :

École : "${schoolTrimmed}"
Programme : "${programTrimmed}"

Tu dois fournir une ESTIMATION prudente :

- Coût total de la formation (en euros)
- Salaire brut annuel moyen à la sortie (en euros)
- Taux d'employabilité à la sortie (en %)

RÈGLES :
- Base-toi sur des ordres de grandeur réalistes.
- N'invente pas de fausse provenance officielle.
- Indique clairement que c'est une "Estimation IA" dans "source".

Réponds STRICTEMENT en JSON :

{
  "cost": nombre ou null,
  "averageSalary": nombre ou null,
  "employabilityRate": nombre ou null,
  "source": "Estimation IA basée sur des ordres de grandeur de marché",
  "schoolQueried": "${schoolTrimmed}",
  "programQueried": "${programTrimmed}"
}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const raw = completion.choices[0].message.content;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("Parse JSON fallback IA KO", raw);
      data = {
        cost: null,
        averageSalary: null,
        employabilityRate: null,
        source: "Estimation IA (JSON non parsé)",
        schoolQueried: schoolTrimmed,
        programQueried: programTrimmed,
      };
    }

    return res.json({
      ...data,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Erreur IA fallback", error);
    return res.status(500).json({ error: "Erreur IA fallback" });
  }
}
