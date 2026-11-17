import type { EnvironmentProviders } from "@angular/core";
import * as angular from "@angular/core";

/** Zoneless change detection, on every Angular the tests run: 20.0 had it under its experimental name. */
export function zoneless(): EnvironmentProviders {
  const api: {
    provideZonelessChangeDetection?: () => EnvironmentProviders;
    provideExperimentalZonelessChangeDetection?: () => EnvironmentProviders;
  } = angular;
  const provide = api.provideZonelessChangeDetection ?? api.provideExperimentalZonelessChangeDetection;
  if (!provide) throw new Error("Angular has no zoneless provider");
  return provide();
}
