import type { EnvironmentProviders } from "@angular/core";
import * as angular from "@angular/core";

/** Angular 20.0 used the experimental name; 20.2 made zoneless stable. */
export function zoneless(): EnvironmentProviders {
  const api: {
    provideZonelessChangeDetection?: () => EnvironmentProviders;
    provideExperimentalZonelessChangeDetection?: () => EnvironmentProviders;
  } = angular;
  const provide = api.provideZonelessChangeDetection ?? api.provideExperimentalZonelessChangeDetection;
  if (!provide) throw new Error("Angular has no zoneless provider");
  return provide();
}
