import React from "react";
import SearchInput from "@/components/search-input";
import Categories from "@/components/categories";
import prismadb from "@/lib/prismadb";
import Companions from "@/components/companions";


export default async function RootPage({ searchParams }: any) {
  const data = await prismadb.companion.findMany({
    where: {
      categoryId: (await searchParams).categoryId || undefined,
      name: {
        search: (await searchParams).name || undefined
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    include: {
      _count: {
        select: {
          messages: true
        }
      }
    }
});

  const categories = await prismadb.category.findMany();

  return (
    <div className="h-full p-4 space-y-2">
      <SearchInput />
      <Categories data={categories} />
      <Companions data={data} />
    </div>
  );
}