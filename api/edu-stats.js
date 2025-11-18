// api/edu-stats.js

const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// ---------- Chargement de sources.json ----------

let sourcesConfig = { sources: [] };

try {
  // sources.json est à la racine du projet
  const sourcesPath = path.join(process.cwd(), "sources.json");
  const file = fs.readFileSync(sourcesPath, "utf8");
  sourcesConfig = JSON.parse(file);
} catch (err) {
  console.error("Erreur lors du chargement de sources.json :", err);
  // on garde sourcesConfig = { sources: [] } pour ne pas faire planter la fonction
}

// ---------- Client OpenAI ----------

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "⚠️ OPENAI_API_KEY n'est pas défini dans les variables d'environnement Vercel."
  );
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Recherche dans les sources ----------

async function searchSources(query, domains) {
  const results = [];

  for (const domain of domains) {
    const url = `https://api.duckduckgo.com/?q=site:${domain}+${encodeURIComponent(
      query
    )}&format=json`;

    try {
      // fetch est global en Node 18+/Vercel
      const resp = await fetch(url);
      const data = await resp.json();
      if (data?.RelatedTopics?.length > 0) {
        results.push({
          domain,
          snippet: data.RelatedTopics[0].Text || "Pas de données précises",
        });
      }
    } catch (err) {
      console.error(`Erreur recherche sur ${domain}:`, err.message);
    }
  }

  return results;
}

// ---------- Handler Serverless ----------

module.exports = async (req, res) => {
  try {
    const { school, program } = req.query || {};

    if (!school || !program) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY manquante côté serveur",
      });
    }

    const query = `${school} ${program} coût salaire employabilité`;
    const domains = (sourcesConfig.sources || []).flatMap(
      (src) => src.domains || []
    );

    const results = await searchSources(query, domains);

    // ---------- Cas 1 : on a trouvé des extraits dans les sources ----------

    if (results.length > 0) {
      const prompt = `
Voici des extraits trouvés sur des sources fiables :
${JSON.stringify(results, null, 2)}

Normalise ces données et renvoie un JSON avec les clés suivantes :
- cost
- averageSalary
- employabilityRate
- source

Réponds STRICTEMENT avec un objet JSON UNIQUEMENT, sans texte autour.
`;

      try {
        const completion = await client.chat.completions.create({
          model: "gpt-4.1-mini",
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        });

        const raw = (completion.choices[0].message.content || "{}").trim();
        let data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error("Erreur de parsing JSON (sources) :", e, "contenu :", raw);
          data = {
            cost: null,
            averageSalary: null,
            employabilityRate: null,
            source: "Réponse IA non parsée",
          };
        }

        return res.json({
          schoolQueried: school,
          programQueried: program,
          ...data,
          refreshedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error("Erreur IA (sources officielles) :", error);
        return res.status(500).json({ error: "Erreur IA" });
      }
    }

    // ---------- Cas 2 : fallback IA sans sources officielles ----------

    try {
      const prompt = `
Donne-moi les statistiques suivantes pour l'école "${school}" et le programme "${program}" :
- Coût de la formation (en euros)
- Salaire moyen à la sortie (en euros)
- Taux d'employabilité à la sortie (en %)

Réponds STRICTEMENT avec un objet JSON au format :
{
  "cost": nombre ou null,
  "averageSalary": nombre ou null,
  "employabilityRate": nombre ou null,
  "source": "texte"
}

Aucun texte en dehors du JSON.
`;

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      });

      const raw = (completion.choices[0].message.content || "{}").trim();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error("Erreur de parsing JSON (fallback) :", e, "contenu :", raw);
        data = {
          cost: null,
          averageSalary: null,
          employabilityRate: null,
          source: "Réponse IA non parsée",
        };
      }

      return res.json({
        schoolQueried: school,
        programQueried: program,
        ...data,
        refreshedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Erreur IA fallback :", error);
      return res.status(500).json({ error: "Erreur IA fallback" });
    }
  } catch (err) {
    console.error("Erreur inattendue dans handler /api/edu-stats :", err);
    return res.status(500).json({ error: "Erreur serveur inattendue" });
  }
};
