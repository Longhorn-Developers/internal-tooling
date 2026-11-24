const FOODPRO_URL = "https://hf-foodpro.austin.utexas.edu/foodpro";
const FOODPRO_FEED_URL = `${FOODPRO_URL}/data_all_endpoint.php`;
const HOUSING_URL = "https://housing.utexas.edu";

export const FOODPRO_APP_URL = `${FOODPRO_URL}/`;
export const HOURS_FEED_URL = `${FOODPRO_FEED_URL}?hours=1`;
export const MENU_FEED_URL = `${FOODPRO_FEED_URL}?menu=1`;
export const HOURS_PAGE_URL = `${HOUSING_URL}/dining/hours-of-operation`;

export function housingUrl(path: string): string {
    return `${HOUSING_URL}${path}`;
}

export function diningCategoryUrl(slug: string): string {
    return housingUrl(`/dining/dining-locations/${slug}`);
}

export function labelUrl(recipeNumber: string, serving: string): string {
    return `${FOODPRO_URL}/label.aspx?RecNumAndPort=${encodeURIComponent(`${recipeNumber}*${serving}`)}`;
}
