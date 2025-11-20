import OpenAI from "openai";
import sourcesConfig from "../sources.json" with { type: "json" };
import officialSources from "../data/official-sources.json" with { type: "json" };
import disciplineMapping from "../data/fr-esr-discipline-mapping.json" with { type: "json" };
import fetch from "node-fetch";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MESR_DATASET =
  "fr-esr-insertion_professionnelle-master_donnees_nationales";
const MESR_BASE_URL =
  "https://data.enseignementsup-recherche.gouv.fr/api/records/1.0/search/";

function guessMesrDiscipline(program) {
  const norm = (program || "").toLowerCase();

  for (const entry of disciplineMapping || []) {
    if (!entry.discipline || !entry.keywords) continue;
    if (entry.keywords.some((kw) => norm.includes(String(kw).toLowerCase()))) {
      return entry.discipline;
    }
  }

  if (/master|m1|m2/.test(norm)) {
    return "Ensemble Masters LMD (hors Masters enseignement)";
  }

  return null;
}

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
    if (!resp.ok) return null;

    const json = await resp.json();
    if (!json.records?.length) return null;

    const f = json.records[0].fields;

    const taux = f.taux_dinsertion || f.taux_d_insertion || null;
    const net = f.salaire_net_mensuel_median || null;

    return {
      cost: null,
      averageSalary: net ? Math.round(net * 12 * 1.3) : null,
      employabilityRate: taux ? Math.round(taux) : null,
      source: `MESR – discipline "${disciplineLabel}" (${year})`,
    };
  } catch (e) {
    console.error("MESR fetch error", e);
    return null;
  }
}

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
        const t = data.RelatedTopics[0];
        results.push({
          domain,
          url: t.FirstURL || null,
          snippet: t.Text || "",
        });
      }
    } catch (err) {
      console.error("DuckDuckGo error", err);
    }
  }
  return results;
}

export default async function handler(req, res) {
  try {
    const { school, program } = req.query;

    if (!school || !program)
      return res.status(400).json({ error: "Paramètres manquants" });

    const schoolTrimmed = school.trim();
    const programTrimmed = program.trim();
    const query = `${schoolTrimmed} ${programTrimmed} coût salaire employabilité`;

    // 1) MESR si Master
    let officialBlock = null;
    if (/master|m1|m2/i.test(programTrimmed)) {
      const disc = guessMesrDiscipline(programTrimmed);
      if (disc) officialBlock = await fetchMesrMasterStats(disc);
    }

    // 2) Sites officiels
    const domains = sourcesConfig.sources.flatMap((s) => s.domains || []);
    const webResults = await searchSources(query, domains);

    // 3) Fusion AI si au moins une source
    if (officialBlock || webResults.length > 0) {
      const prompt = `
Voici des données pour fusionner :

OFFICIEL :
${JSON.stringify(officialBlock, null, 2)}

WEB :
${JSON.stringify(webResults, null, 2)}

RÈGLES :
- Si officiel existe, il est prioritaire.
- Ne pas inventer de chiffres. Null si inconnu.
- Indiquer clairement dans "source" ce qui provient du MESR, du web ou estimé.
- FORMAT STRICT JSON :

{
  "cost": ...,
  "averageSalary": ...,
  "employabilityRate": ...,
  "source": "...",
  "schoolQueried": "${schoolTrimmed}",
  "programQueried": "${programTrimmed}"
}`;

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });

      let data;
      try {
        data = JSON.parse(completion.choices[0].message.content);
      } catch {
        data = {
          cost: officialBlock?.cost || null,
          averageSalary: officialBlock?.averageSalary || null,
          employabilityRate: officialBlock?.employabilityRate || null,
          source:
            officialBlock?.source ||
            "Fusion IA (réponse non parsée), données officielles partielles",
          schoolQueried: schoolTrimmed,
          programQueried: programTrimmed,
        };
      }

      return res.json({ ...data, refreshedAt: new Date().toISOString() });
    }

    // 4) Fallback IA
    const fallbackPrompt = `
Aucune source officielle trouvée pour :
${schoolTrimmed} – ${programTrimmed}

Donne une estimation prudente, en JSON strict :

{
  "cost": ...,
  "averageSalary": ...,
  "employabilityRate": ...,
  "source": "Estimation IA",
  "schoolQueried": "${schoolTrimmed}",
  "programQueried": "${programTrimmed}"
}`;

    const fallback = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: fallbackPrompt }],
    });

    let fallbackData;
    try {
      fallbackData = JSON.parse(fallback.choices[0].message.content);
    } catch {
      fallbackData = {
        cost: null,
        averageSalary: null,
        employabilityRate: null,
        source: "Estimation IA (non parsée)",
        schoolQueried: schoolTrimmed,
        programQueried: programTrimmed,
      };
    }

    return res.json({ ...fallbackData, refreshedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Erreur API edu-stats", err);
    return res.status(500).json({ error: "Erreur serveur edu-stats" });
  }
}
