# OrchID — optional language packs

The default OrchID build ships **English only**. Every other locale has been
extracted out of the UI build into this directory, one folder per language pack.
The translation data is preserved here and can be re-enabled at any time — nothing
was deleted.

## Available packs

| Code      | Language               |
|-----------|------------------------|
| `ru-RU`   | Русский (Russian)      |
| `es`      | Español (Spanish)      |
| `fr`      | Français (French)      |
| `ja`      | 日本語 (Japanese)        |
| `ko`      | 한국어 (Korean)          |
| `pl`      | Język polski (Polish)  |
| `pt-BR`   | Português (Brasil)     |
| `be-BY`   | Беларуская (Belarusian)|
| `tt-RU`   | Татар (Tatar)          |
| `kk-KZ`   | Қазақ (Kazakh)         |
| `zh-CN`   | 简体中文 (Simplified Chinese)  |
| `zh-Hant` | 繁體中文 (Traditional Chinese) |

Each `<code>/` folder contains a `translation.json` bundle.

## Re-enabling a language

To add a pack back into the default build, do all three steps for the `<code>`
you want (e.g. `ru-RU`):

1. **Copy the translation folder back** into the UI's public locales directory:

   ```sh
   cp -r locale-packages/<code> ui/public/locales/<code>
   ```

2. **Add the code to `SUPPORTED_LANGUAGES`** in
   [ui/src/config/i18n/i18n.ts](../ui/src/config/i18n/i18n.ts):

   ```ts
   export const SUPPORTED_LANGUAGES = ['en', '<code>'] as const
   ```

3. **Add a display name to `OPTION_NAMES`** in
   [ui/src/components/ui/lang-switcher/lang-switcher.tsx](../ui/src/components/ui/lang-switcher/lang-switcher.tsx),
   so the language switcher can render it and the build type-checks (the map is
   keyed by the `SUPPORTED_LANGUAGES` union — a missing key is a TS error):

   ```ts
   const OPTION_NAMES: Record<SupportedLanguages, string> = {
     en: 'English',
     ['<code>']: '<Native language name>',
   }
   ```

4. **Rebuild the UI:**

   ```sh
   cd ui && npx tsc -b && npx vite build
   ```

The language will then be selectable again in the app's language switcher.
