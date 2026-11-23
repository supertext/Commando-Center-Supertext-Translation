package com.supertext.pluginhealth;

/**
 * One language of the system and the Supertext code it is translated as (see {@link InstallationReporter#sendLanguages}).
 *
 * @param code      the system's own code, as it shows it: {@code de_CH}, {@code en-GB}, {@code zh_Hans_CN}, …; required
 * @param supertext the Supertext code the plugin uses for it ({@code de-CH}, {@code fr-FR}, {@code zh-Hans}, …), or
 *                  {@code null}: not mapped
 */
public record LanguageMapping(String code, String supertext) {
}
