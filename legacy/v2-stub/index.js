/**
 * Stub package: @brycehamrick/opencode-v2-hindsight
 *
 * This package was renamed to @brycehamrick/opencode-hindsight.
 * The stub re-exports the real plugin so existing configs keep working,
 * while warning at load time. To migrate, change your opencode config:
 *
 *   "package": "@brycehamrick/opencode-v2-hindsight"
 *   ->
 *   "package": "@brycehamrick/opencode-hindsight"
 *
 * The stub depends on ^0.3.0 of the real package, so forwarding also
 * picks up fixes. It will be maintained through 1.x of the real package;
 * after that it may go quiet.
 */
import plugin from "@brycehamrick/opencode-hindsight";

console.warn(
  "[hindsight] @brycehamrick/opencode-v2-hindsight was renamed to " +
    "@brycehamrick/opencode-hindsight. This stub forwards to the new " +
    'package — update the "package" field in your opencode config to stop ' +
    "seeing this warning."
);

export default plugin;
export const { id, setup } = plugin;
