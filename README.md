# Poste de travail ProtoKomo

Ce dépôt privé a été créé par l'application iPhone **ProtoKomo**. Il fait tourner **Claude Code** (le programme
officiel d'Anthropic, non modifié) dans GitHub Actions, avec **votre abonnement Claude**, pour modifier vos sites
quand vous le demandez depuis l'iPhone. Aucun ordinateur n'a besoin d'être allumé.

- `.github/workflows/protokomo.yml` : déclenché par l'app à chaque demande.
- `protokomo/run.mjs` : ouvre le site, lance Claude Code avec les mêmes réglages que ProtoKomo sur ordinateur,
  enregistre le résultat sur la branche `protokomo-brouillon` du site, prépare l'aperçu.
- Branche `etat` : avancement de chaque demande, lu par l'app. Branches `apercu/…` : sites construits pour l'aperçu.

## Secrets (Settings → Secrets and variables → Actions)

| Nom | Contenu |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Jeton de **votre** abonnement Claude, créé par la commande officielle d'Anthropic `claude setup-token`. ProtoKomo ne le voit jamais. |
| `PROTOKOMO_GITHUB_TOKEN` | Jeton GitHub qui permet au poste d'ouvrir vos sites et d'enregistrer le brouillon. |

Pour créer le jeton Claude sans ordinateur : **Code → Codespaces → Create codespace** sur ce dépôt, puis dans le
terminal `npx @anthropic-ai/claude-code setup-token`. Connectez-vous sur la page d'Anthropic, copiez le jeton
affiché et collez-le dans le secret `CLAUDE_CODE_OAUTH_TOKEN`. Il vaut un an.

## Coûts

L'usage de Claude compte dans les limites de votre abonnement Claude (Pro, Max…). Les minutes GitHub Actions d'un
dépôt privé sont gratuites jusqu'au quota de votre compte GitHub (2 000 min/mois sur le plan gratuit).

Claude et Claude Code sont des marques d'Anthropic. ProtoKomo n'est ni affilié à Anthropic ni approuvé par Anthropic.
