export function toggleProfileSection(collapsed, title) {
    return { ...collapsed, [title]: !collapsed[title] };
}
