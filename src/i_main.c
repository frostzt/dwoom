//
// Copyright(C) 1993-1996 Id Software, Inc.
// Copyright(C) 2005-2014 Simon Howard
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//	Main program, simply calls D_DoomMain high level loop.
//

#include "config.h"

#include <assert.h>
#include <emscripten/em_macros.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "SDL.h"

#include "d_loop.h"
#include "doom/d_main.h"
#include "doom/g_game.h"
#include "doomkeys.h"
#include "doomtype.h"
#include "i_system.h"
#include "i_video.h"
#include "m_argv.h"
#include "m_misc.h"
#include "d_event.h"

#define BIT_UP    (1 << 0)
#define BIT_DOWN  (1 << 1)
#define BIT_LEFT  (1 << 2)
#define BIT_RIGHT (1 << 3)
#define BIT_FIRE  (1 << 4)
#define BIT_USE   (1 << 5)

//
// D_DoomMain()
// Not a globally visible function, just included for source reference,
// calls all startup code, parses command line options.

extern void D_ProcessEvents(void);
extern boolean D_Display(void);
extern void G_Ticker(void);

void D_DoomMain(void);

// This too is not globally visible
// void D_Display(void);

static char *default_argv[] = {"doom", "-iwad", "DOOM1.WAD", NULL};
static int default_argc = 3;

static int last_mask = 0;

static void post_key(int key, int is_down)
{
    event_t ev;
    ev.type = is_down ? ev_keydown : ev_keyup;
    ev.data1 = key;
    D_PostEvent(&ev); // Pushes event to Doom's event queue
}

EMSCRIPTEN_KEEPALIVE
int worker_doom_init(void)
{
    myargc = default_argc;
    myargv = default_argv;

    D_DoomMain();

    return 0;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *worker_get_framebuffer(void)
{
    return I_VideoBuffer;
}

EMSCRIPTEN_KEEPALIVE
void worker_doom_tick(int input_mask)
{
    int changed = input_mask ^ last_mask;

    if (changed & BIT_UP)
    {
        post_key(KEY_UPARROW, input_mask & BIT_UP);
    }

    if (changed & BIT_DOWN)
    {
        post_key(KEY_DOWNARROW, input_mask & BIT_DOWN);
    }

    if (changed & BIT_LEFT)
    {
        post_key(KEY_LEFTARROW, input_mask & BIT_LEFT);
    }

    if (changed & BIT_RIGHT)
    {
        post_key(KEY_RIGHTARROW, input_mask & BIT_RIGHT);
    }

    if (changed & BIT_FIRE)
    {
        post_key(KEY_LCTRL, input_mask & BIT_FIRE);
    }

    if (changed & BIT_USE)
    {
        post_key('e', input_mask & BIT_USE);
    }

    last_mask = input_mask;

    D_ProcessEvents();
    G_Ticker();
    D_Display();
}


// int main(int argc, char **argv)
// {
//     // save arguments
//
//     myargc = argc;
//     myargv = malloc(argc * sizeof(char *));
//     assert(myargv != NULL);
//
//     for (int i = 0; i < argc; i++)
//     {
//         myargv[i] = M_StringDuplicate(argv[i]);
//     }
//
//     //!
//     // Print the program version and exit.
//     //
//     if (M_ParmExists("-version") || M_ParmExists("--version"))
//     {
//         puts(PACKAGE_STRING);
//         exit(0);
//     }
//
// #if defined(_WIN32)
//     // compose a proper command line from loose file paths passed as arguments
//     // to allow for loading WADs and DEHACKED patches by drag-and-drop
//     M_AddLooseFiles();
// #endif
//
//     M_FindResponseFile();
//     M_SetExeDir();
//
//     SDL_SetHint(SDL_HINT_NO_SIGNAL_HANDLERS, "1");
//
//     // start doom
//
//     D_DoomMain();
//
//
//     return 0;
// }
