// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

import { OpenCascadeInstance } from 'replicad-opencascadejs'

const OC: { library: OpenCascadeInstance | null } = {
  library: null,
}

export const setOC = (oc: OpenCascadeInstance): void => {
  OC.library = oc
}

export const getOC = (): OpenCascadeInstance => {
  if (!OC.library) throw new Error('oppencascade has not been loaded')
  return OC.library
}
