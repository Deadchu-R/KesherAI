import { useEffect, useState } from "react";
import { api, type ModelInfo, type ModelListing } from "./api";

/**
 * Loads every model from `/api/models`, optionally filtered by category.
 *
 * @param category - e.g. `chat` or `image`; omit for all.
 * @returns Models, provider errors, and a `reload` function.
 */
export function useModels(category?: string) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [errors, setErrors] = useState<ModelListing["errors"]>([]);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    api<ModelListing>("/api/models")
      .then((l) => {
        setModels(category ? l.models.filter((m) => m.category === category) : l.models);
        setErrors(l.errors);
      })
      .catch((e: Error) => setErrors([{ providerId: "core", message: e.message }]))
      .finally(() => setLoading(false));
  };

  useEffect(reload, [category]);
  return { models, errors, loading, reload };
}
