# OrchID — Russian (ru-RU) language pack

This is the **optional Russian language pack**, removed from the default OrchID
build. It is preserved here as an installable package rather than shipped with
the app.

## Contents

- `translation.json` — the full Russian (`ru-RU`) translation bundle.

## How to re-enable Russian in the build

1. Copy the translation bundle back into the UI's public locales directory:

   ```sh
   mkdir -p ui/public/locales/ru-RU
   cp locale-packages/ru-RU/translation.json ui/public/locales/ru-RU/translation.json
   ```

2. Add `'ru-RU'` back to the `SUPPORTED_LANGUAGES` array in
   [ui/src/config/i18n/i18n.ts](../../ui/src/config/i18n/i18n.ts).

3. Rebuild the UI:

   ```sh
   cd ui && npx tsc -b && npx vite build
   ```

Russian will then be available again as a selectable language.
