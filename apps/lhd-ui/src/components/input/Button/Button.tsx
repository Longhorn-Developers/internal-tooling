export const Button = ({ children }: { children: React.ReactNode }) => (
    <button className="px-4 py-2 rounded bg-orange-600 text-white hover:bg-orange-700 dark:hover:bg-blue-700">
        {children}
    </button>
)
