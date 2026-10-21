import type { ModelOption } from '@beddcode/contracts'

export function modelEfforts(models: ModelOption[], fallback: string[], modelId?: string) {
  return models.find((model) => model.id === modelId)?.efforts ?? fallback
}

export function modelChoice(
  models: ModelOption[],
  efforts: string[],
  value: { model?: string; effort?: string },
) {
  const model = models.some((option) => option.id === value.model) ? value.model : undefined
  return {
    model,
    effort: modelEfforts(models, efforts, model).includes(value.effort ?? '')
      ? value.effort
      : undefined,
  }
}
