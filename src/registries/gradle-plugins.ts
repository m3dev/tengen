import { MavenRegistryProxy } from './maven.ts';

/**
 * Proxy for the Gradle Plugin Portal (https://plugins.gradle.org/m2).
 *
 * The portal serves artifacts in standard Maven m2 layout — plugin marker
 * artifacts (`{pluginId}.gradle.plugin`) and the real implementation modules
 * alike — so routing, metadata filtering, and download gating are inherited
 * verbatim from MavenRegistryProxy. deps.dev indexes the marker artifacts under
 * the Maven ecosystem, so the age filter resolves publish dates the same way.
 *
 * Two things differ from plain Maven:
 *   - `name` mounts this proxy under a distinct URL prefix (/gradle-plugins)
 *   - `dbKey` points the malicious/allowlist lookups at the shared "maven"
 *     ecosystem, since OSV tracks Gradle plugin artifacts there.
 *
 * The portal answers maven-metadata.xml for backing implementation modules with
 * a 303 to the hosting repo; MavenRegistryProxy follows metadata redirects
 * server-side, so that resolves through the age/malicious filter as usual.
 */
export class GradlePluginsRegistryProxy extends MavenRegistryProxy {
  readonly name = 'gradle-plugins';

  protected override get dbKey(): string {
    return 'maven';
  }
}
