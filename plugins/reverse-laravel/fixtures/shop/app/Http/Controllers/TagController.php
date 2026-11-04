<?php

namespace App\Http\Controllers;

class TagController extends Controller
{
    public function index()
    {
        return response()->json(['tags' => ['php', 'laravel']], 200);
    }
}
