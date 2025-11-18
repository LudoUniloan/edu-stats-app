const form = document.getElementById("stats-form");
const schoolInput = document.getElementById("school-input");
const programInput = document.getElementById("program-input");

const statusEl = document.getElementById("status");
const costEl = document.getElementById("cost");
const avgSalaryEl = document.getElementById("average-salary");
const employabilityEl = document.getElementById("employability-rate");
const sourceEl = document.getElementById("source");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const school = schoolInput.value.trim();
  const program = programInput.value.trim();

  if (!school || !program) {
    statusEl.textContent = "Merci de renseigner l'école et le programme.";
    return;
  }

  statusEl.textContent = "Chargement...";
  costEl.textContent = "—";
  avgSalaryEl.textContent = "—";
  employabilityEl.textContent = "—";
  sourceEl.textContent = "—";

  try {
    const params = new URLSearchParams({ school, program });
    const url = `/api/edu-stats?${params.toString()}`;
    console.log("Appel API :", url);

    const res = await fetch(url);

    if (!res.ok) {
      statusEl.textContent = `Erreur API (${res.status})`;
      return;
    }

    const data = await res.json();
    console.log("Réponse API :", data);

    costEl.textContent =
      data.cost != null ? `${data.cost} €` : "Non disponible";
    avgSalaryEl.textContent =
      data.averageSalary != null ? `${data.averageSalary} €` : "Non disponible";
    employabilityEl.textContent =
      data.employabilityRate != null
        ? `${data.employabilityRate} %`
        : "Non disponible";
    sourceEl.textContent = data.source || "Non disponible";

    statusEl.textContent = `Dernière mise à jour : ${
      data.refreshedAt || "—"
    }`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Erreur réseau ou serveur.";
  }
});
