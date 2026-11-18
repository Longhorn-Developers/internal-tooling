export const Button = ({ children }: { children: React.ReactNode }) => (
    <button className="px-4 py-2 rounded cursor-pointer text-white
        bg-ut-burnt-orange hover:bg-ut-burnt-orange-600">
        {children}
    </button>
)
