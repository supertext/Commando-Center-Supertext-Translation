package com.supertext.pluginhealth;

/**
 * Another plugin, extension, module or theme installed on the site (see {@link InstallationReporter#sendExtensions}).
 *
 * @param name    as the system shows it, e.g. {@code Polylang Pro}; required
 * @param version its version, or {@code null}
 * @param active  whether it is enabled; {@code null} if the system doesn't say
 * @param type    the system's own word: plugin, theme, module, extension, bundle, package, app, …; or {@code null}
 */
public record Extension(String name, String version, Boolean active, String type) {

    /** An extension with only a name and a version. */
    public Extension(String name, String version) {
        this(name, version, null, null);
    }
}
