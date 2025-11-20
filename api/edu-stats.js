import OpenAI from "openai";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================
// Chargement de sources.json SANS assert / with
// ============================

let sourcesConfig = { sources: [] };

try {
  const sourcesPath = path.join(process.cwd(), "sources.json");
  const raw = fs.readFileSync(sourcesPath, "utf8");
  sourcesConfig = JSON.parse(raw);
} catch (e) {
  console.error("Impossible de charger sources.json :", e.message);
}

// ============================
// Recherche sur les domaines prioritaires
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
        results.push({
          domain,
          snippet: data.RelatedTopics[0].Text || "Pas de données précises",
          url: data.RelatedTopics[0].FirstURL || null,
        });
      }
    } catch (err) {
      console.error(`Erreur recherche sur ${domain}:`, err.message);
    }
  }
  return results;
}

// ============================
// Handler principal
// ============================

export default async function handler(req, res) {
  try {
    const { school, program } = req.query;

    if (!school || !program) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }

    const schoolTrimmed = String(school).trim();
    const programTrimmed = String(program).trim();

    const query = `${schoolTrimmed} ${programTrimmed} coût salaire employabilité`;
    const domains =
      (sourcesConfig.sources || []).flatMap((src) => src.domains || []) || [];

    const results = await searchSources(query, domains);

    // 1) Si on a trouvé quelque chose sur les sources prioritaires → on demande à l'IA de normaliser
    if (results.length > 0) {
      const prompt = `
Voici des extraits trouvés sur des sources considérées comme fiables (sites officiels d'écoles, INSEE, etc.) :

${JSON.stringify(results, null, 2)}

École : "${schoolTrimmed}"
Programme : "${programTrimmed}"

Normalise ces données et renvoie STRICTEMENT un JSON avec les clés suivantes :

{
  "cost": nombre ou null,
  "averageSalary": nombre ou null,
  "employabilityRate": nombre ou null,
  "source": "description courte de la ou des sources utilisées (par ex. Site officiel HEC Paris 2023)",
  "schoolQueried": "${schoolTrimmed}",
  "programQueried": "${programTrimmed}"
}
`;

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });

      let data;
      const raw = completion.choices[0].message.content;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error("Parse JSON (sources officielles) KO :", raw);
        data = {
          cost: null,
          averageSalary: null,
          employabilityRate: null,
          source: "Réponse IA non parsée (sources officielles)",
          schoolQueried: schoolTrimmed,
          programQueried: programTrimmed,
        };
      }

      return res.json({
        ...data,
        refreshedAt: new Date().toISOString(),
      });
    }

    // 2) Fallback : estimation IA quand aucune source officielle exploitable
    const fallbackPrompt = `
Aucune source officielle exploitable n'a été trouvée automatiquement pour :

École : "${schoolTrimmed}"
Programme : "${programTrimmed}"

Donne une ESTIMATION prudente des ordres de grandeur suivants, et rien d'autre, sous forme de JSON strict :

{
  "cost": nombre ou null,
  "averageSalary": nombre ou null,
  "employabilityRate": nombre ou null,
  "source": "Estimation IA basée sur des ordres de grandeur du marché",
  "schoolQueried": "${schoolTrimmed}",
  "programQueried": "${programTrimmed}"
}
`;

    const fallbackCompletion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: fallbackPrompt }],
    });

    let fallbackData;
    const fallbackRaw = fallbackCompletion.choices[0].message.content;
    try {
      fallbackData = JSON.parse(fallbackRaw);
    } catch (e) {
      console.error("Parse JSON fallback IA KO :", fallbackRaw);
      fallbackData = {
        cost: null,
        averageSalary: null,
        employabilityRate: null,
        source: "Estimation IA (JSON non parsé)",
        schoolQueried: schoolTrimmed,
        programQueried: programTrimmed,
      };
    }

    return res.json({
      ...fallbackData,
      refreshedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Erreur serveur /api/edu-stats :", err);
    return res.status(500).json({ error: "Erreur serveur edu-stats" });
  }
}
